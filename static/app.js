/* ══════════════════════════════════════════════════════════════
   BoardPrep PH — Frontend JS v2 (Auth + Profiles + Tracker)
   ══════════════════════════════════════════════════════════════ */

const SUBJECT_COLORS = ['#4f8ef7','#a78bfa','#34d399','#f97316','#f43f5e','#06b6d4','#eab308','#8b5cf6','#e879f9','#2dd4bf'];
const NOTE_COLORS    = ['#fef08a','#bbf7d0','#bfdbfe','#fecaca','#e9d5ff','#fed7aa','#d1fae5','#fce7f3'];

let currentUser  = null;   // logged-in user object
let loginTarget  = null;   // profile being unlocked
let subjects     = [];
let notes        = [];
let ctx          = {};
let avatarDataUrl = null;  // pending avatar upload preview

// ══════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════
async function boot() {
  buildColorPickers();

  // Fire both requests in parallel — saves one full round trip on load
  const [configResp, meResp] = await Promise.allSettled([
    fetch('/api/config'),
    fetch('/api/auth/me-full', { credentials: 'include' })
  ]);

  // Apply config
  try {
    if (configResp.status === 'fulfilled' && configResp.value.ok) {
      const cfg = await configResp.value.json();
      if (cfg.gemini_key) window.__GEMINI_KEY__ = cfg.gemini_key;
    }
  } catch(e) {}

  // Check if already logged in — me-full returns user + subjects + notes at once
  try {
    if (meResp.status === 'fulfilled' && meResp.value.ok) {
      const full = await meResp.value.json();
      currentUser = full.user;
      subjects    = full.subjects || [];
      notes       = full.notes    || [];
      // Enter tracker and render immediately — no extra fetches needed
      await enterTrackerWithData();
      return;
    }
  } catch(e) {}

  showView('landing');
}

// ══════════════════════════════════════════════════════════════
//  VIEW ROUTER
// ══════════════════════════════════════════════════════════════
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(`view-${name}`).style.display = 'block';
}

// ══════════════════════════════════════════════════════════════
//  LANDING — Profile Cards
// ══════════════════════════════════════════════════════════════
// All profiles stored in memory so search doesn't need re-fetch
let allProfiles = [];

async function loadProfiles() {
  const grid = document.getElementById('profilesGrid');
  grid.innerHTML = '<div class="loading-state">Loading profiles…</div>';

  // Reset search bar
  const searchInput = document.getElementById('profileSearch');
  const clearBtn    = document.getElementById('searchClearBtn');
  const countEl     = document.getElementById('profileSearchCount');
  if (searchInput) searchInput.value = '';
  if (clearBtn)    clearBtn.style.display = 'none';
  if (countEl)     countEl.textContent = '';

  try {
    const r = await fetch('/api/profiles');
    allProfiles = await r.json();

    if (allProfiles.length === 0) {
      grid.innerHTML = `
        <div class="loading-state" style="grid-column:1/-1">
          <div style="font-size:2.5rem;margin-bottom:.75rem">👤</div>
          <div style="font-size:1rem;color:var(--text2)">No profiles yet.</div>
          <div style="font-size:.85rem;color:var(--text3);margin-top:4px">Be the first to create one!</div>
        </div>`;
      return;
    }

    renderProfileCards(allProfiles, '');
  } catch(e) {
    grid.innerHTML = '<div class="loading-state">Failed to load profiles.</div>';
  }
}

function renderProfileCards(profiles, query) {
  const grid = document.getElementById('profilesGrid');
  grid.innerHTML = '';

  if (profiles.length === 0 && query) {
    grid.innerHTML = `
      <div class="no-results-state">
        <div class="no-results-icon">🔍</div>
        <p>No profiles found for "<strong>${esc(query)}</strong>"</p>
        <span>Try a different name or username</span>
      </div>`;
    return;
  }

  profiles.forEach(p => {
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.dataset.name     = p.display_name.toLowerCase();
    card.dataset.username = p.username.toLowerCase();
    card.onclick = () => openLoginForProfile(p);

    const avatarHTML = p.avatar
      ? `<img src="${p.avatar}" alt="${esc(p.display_name)}">`
      : `<span>${esc(p.display_name[0].toUpperCase())}</span>`;

    // Highlight matched text
    const hlName     = highlight(esc(p.display_name), query);
    const hlUsername = highlight(esc(p.username), query);

    card.innerHTML = `
      <div class="profile-card-avatar">${avatarHTML}</div>
      <div class="profile-card-name">${hlName}</div>
      <div class="profile-card-username">@${hlUsername}</div>
      <div class="profile-card-progress">
        <div class="profile-card-bar-wrap">
          <div class="profile-card-bar-fill" style="width:${p.progress_pct}%"></div>
        </div>
        <div class="profile-card-pct">${p.progress_pct}% reviewed</div>
      </div>
      <div class="profile-card-meta">${p.subject_count} subject${p.subject_count !== 1 ? 's' : ''}</div>
      <div class="profile-lock">🔒 Password protected</div>`;
    grid.appendChild(card);
  });
}

function filterProfiles(query) {
  const q         = query.trim().toLowerCase();
  const clearBtn  = document.getElementById('searchClearBtn');
  const countEl   = document.getElementById('profileSearchCount');

  // Show/hide clear button
  if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';

  if (!q) {
    renderProfileCards(allProfiles, '');
    if (countEl) countEl.textContent = '';
    return;
  }

  // Filter by display_name or username
  const filtered = allProfiles.filter(p =>
    p.display_name.toLowerCase().includes(q) ||
    p.username.toLowerCase().includes(q)
  );

  renderProfileCards(filtered, q);

  // Update count label
  if (countEl) {
    if (filtered.length === 0) {
      countEl.textContent = 'No profiles found';
      countEl.className = 'profile-search-count';
    } else if (filtered.length === allProfiles.length) {
      countEl.textContent = '';
    } else {
      countEl.textContent = `${filtered.length} of ${allProfiles.length} profiles`;
      countEl.className = 'profile-search-count has-results';
    }
  }
}

function clearProfileSearch() {
  const input = document.getElementById('profileSearch');
  if (input) {
    input.value = '';
    input.focus();
  }
  filterProfiles('');
}

function highlight(text, query) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex   = new RegExp(`(${escaped})`, 'gi');
  return text.replace(regex, '<span class="search-highlight">$1</span>');
}

// ══════════════════════════════════════════════════════════════
//  AUTH — Register
// ══════════════════════════════════════════════════════════════
// Holds email between step 1 and step 2
let pendingEmail = '';
let resendCooldown = null;

async function doRequestCode() {
  const username     = document.getElementById('reg-username').value.trim();
  const display_name = document.getElementById('reg-display').value.trim();
  const email        = document.getElementById('reg-email').value.trim();
  const password     = document.getElementById('reg-password').value;
  const errEl        = document.getElementById('reg-error');
  const btn          = document.getElementById('reg-btn');
  errEl.textContent  = '';

  // Client-side validation
  if (!username)           { errEl.textContent = 'Please enter a username.'; return; }
  if (username.length < 3) { errEl.textContent = 'Username must be at least 3 characters.'; return; }
  if (!email || !email.includes('@')) { errEl.textContent = 'Please enter a valid email address.'; return; }
  if (!password)           { errEl.textContent = 'Please enter a password.'; return; }
  if (password.length < 4) { errEl.textContent = 'Password must be at least 4 characters.'; return; }

  btn.textContent = 'Sending code…';
  btn.disabled = true;

  try {
    const r = await fetch('/api/auth/request-code', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, display_name, email, password })
    });
    const data = await r.json();
    if (!r.ok) {
      errEl.textContent = data.error || 'Something went wrong. Please try again.';
      return;
    }

    // Store email for step 2
    pendingEmail = email;

    // Show step 2
    const sub = document.getElementById('verify-sub');
    sub.textContent = `We sent a 6-digit code to ${email}`;
    document.getElementById('verify-code').value = '';
    document.getElementById('verify-error').textContent = '';

    // Dev mode — show code hint
    if (data.dev_mode) {
      document.getElementById('verify-error').style.color = 'var(--green)';
      document.getElementById('verify-error').textContent = '⚙️ Dev mode: check the Railway logs for your code.';
    }

    showView('verify');
    setTimeout(() => document.getElementById('verify-code').focus(), 150);
    startResendCooldown();
  } catch(e) {
    errEl.textContent = 'Connection error. Please check your internet and try again.';
  } finally {
    btn.textContent = 'Send Verification Code';
    btn.disabled = false;
  }
}

async function doVerifyCode() {
  const code  = document.getElementById('verify-code').value.trim();
  const errEl = document.getElementById('verify-error');
  const btn   = document.getElementById('verify-btn');
  errEl.textContent = '';
  errEl.style.color = 'var(--red)';

  if (!code || code.length !== 6) { errEl.textContent = 'Please enter the 6-digit code.'; return; }

  btn.textContent = 'Verifying…';
  btn.disabled = true;

  try {
    const r = await fetch('/api/auth/register', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email: pendingEmail, code })
    });
    const data = await r.json();
    if (!r.ok) {
      errEl.textContent = data.error || 'Verification failed. Please try again.';
      return;
    }
    currentUser = data;
    subjects = []; notes = [];
    await enterTracker();
  } catch(e) {
    errEl.textContent = 'Connection error. Please try again.';
  } finally {
    btn.textContent = 'Verify & Create Profile';
    btn.disabled = false;
  }
}

async function doResendCode() {
  if (resendCooldown) return;
  // Re-trigger request-code with the same form values
  showView('register');
  setTimeout(() => doRequestCode(), 100);
}

function startResendCooldown() {
  // Disable resend link for 30 seconds
  const link = document.getElementById('resend-link');
  if (!link) return;
  let secs = 30;
  link.textContent = `Resend code (${secs}s)`;
  link.classList.add('resend-cooldown');
  resendCooldown = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearInterval(resendCooldown);
      resendCooldown = null;
      link.textContent = 'Resend code';
      link.classList.remove('resend-cooldown');
    } else {
      link.textContent = `Resend code (${secs}s)`;
    }
  }, 1000);
}

// ══════════════════════════════════════════════════════════════
//  AUTH — Forgot / Reset Password
// ══════════════════════════════════════════════════════════════

let forgotEmail = '';  // remember email between forgot → reset steps

function openForgotPassword() {
  // Pre-fill email from the current login target if available
  const emailInput = document.getElementById('forgot-email');
  if (emailInput && loginTarget) emailInput.value = '';
  document.getElementById('forgot-error').textContent = '';
  const succ = document.getElementById('forgot-success');
  if (succ) { succ.style.display = 'none'; succ.textContent = ''; }
  showView('forgot');
  setTimeout(() => document.getElementById('forgot-email')?.focus(), 150);
}

async function doForgotPassword() {
  const email = document.getElementById('forgot-email').value.trim().toLowerCase();
  const errEl = document.getElementById('forgot-error');
  const succEl = document.getElementById('forgot-success');
  const btn   = document.getElementById('forgot-btn');
  errEl.textContent = '';
  errEl.className = 'auth-error';
  if (succEl) succEl.style.display = 'none';

  if (!email || !email.includes('@')) {
    errEl.textContent = 'Please enter a valid email address.';
    return;
  }

  btn.textContent = 'Sending…';
  btn.disabled = true;

  try {
    const r = await fetch('/api/auth/forgot-password', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email })
    });
    const d = await r.json();

    if (r.status === 429) {
      errEl.className = 'auth-error rate-limit';
      errEl.textContent = d.error;
      return;
    }
    if (!r.ok) { errEl.textContent = d.error; return; }

    // Always show success (even if email not found — security)
    forgotEmail = email;
    if (succEl) {
      succEl.textContent = `✅ If an account exists for ${email}, a reset code has been sent. Check your inbox!`;
      succEl.style.display = 'block';
    }

    // Dev mode hint
    if (d.dev_mode) {
      errEl.style.color = 'var(--green)';
      errEl.textContent = '⚙️ Dev mode: check Railway logs for the code.';
    }

    // Auto-navigate to reset step after 1.5s
    setTimeout(() => {
      document.getElementById('reset-sub').textContent = `Enter the code sent to ${email}`;
      document.getElementById('reset-code').value = '';
      document.getElementById('reset-new-pw').value = '';
      document.getElementById('reset-confirm-pw').value = '';
      document.getElementById('reset-error').textContent = '';
      showView('reset');
      setTimeout(() => document.getElementById('reset-code')?.focus(), 150);
    }, 1500);

  } catch(e) {
    errEl.textContent = 'Connection error. Please try again.';
  } finally {
    btn.textContent = 'Send Reset Code';
    btn.disabled = false;
  }
}

async function doResetPassword() {
  const code    = document.getElementById('reset-code').value.trim();
  const newPw   = document.getElementById('reset-new-pw').value;
  const confirm = document.getElementById('reset-confirm-pw').value;
  const errEl   = document.getElementById('reset-error');
  const btn     = document.getElementById('reset-btn');
  errEl.textContent = '';
  errEl.className = 'auth-error';

  if (!code || code.length !== 6) { errEl.textContent = 'Please enter the 6-digit code.'; return; }
  if (!newPw)                      { errEl.textContent = 'Please enter a new password.'; return; }
  if (newPw.length < 4)            { errEl.textContent = 'Password must be at least 4 characters.'; return; }
  if (newPw !== confirm)           { errEl.textContent = 'Passwords do not match.'; return; }

  btn.textContent = 'Resetting…';
  btn.disabled = true;

  try {
    const r = await fetch('/api/auth/reset-password', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email: forgotEmail, code, new_password: newPw })
    });
    const d = await r.json();

    if (r.status === 429) {
      errEl.className = 'auth-error rate-limit';
      errEl.textContent = d.error;
      return;
    }
    if (!r.ok) { errEl.textContent = d.error; return; }

    // Success — go back to landing with a toast
    showToast('✅ Password reset! You can now log in.');
    showView('landing');
    loadProfiles();

  } catch(e) {
    errEl.textContent = 'Connection error. Please try again.';
  } finally {
    btn.textContent = 'Set New Password';
    btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  AUTH — Login
// ══════════════════════════════════════════════════════════════
function openLoginForProfile(profile) {
  loginTarget = profile;
  const avatarEl = document.getElementById('loginAvatar');
  if (profile.avatar) {
    avatarEl.innerHTML = `<img src="${profile.avatar}" alt="">`;
  } else {
    avatarEl.innerHTML = `<span style="font-size:2rem">${profile.display_name[0].toUpperCase()}</span>`;
  }
  document.getElementById('loginTitle').textContent = `Welcome, ${profile.display_name}`;
  document.getElementById('loginSub').textContent   = '@' + profile.username;
  document.getElementById('login-password').value   = '';
  document.getElementById('login-error').textContent = '';
  showView('login');
  setTimeout(() => document.getElementById('login-password').focus(), 150);
}

async function doLogin() {
  if (!loginTarget) return;
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.querySelector('#view-login .btn-primary');
  errEl.textContent = '';

  if (!password) { errEl.textContent = 'Please enter your password.'; return; }

  btn.textContent = 'Unlocking…';
  btn.disabled = true;

  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username: loginTarget.username, password })
    });
    const data = await r.json();
    if (!r.ok) {
      errEl.textContent = data.error || 'Incorrect password.';
      return;
    }
    currentUser = data;
    await enterTracker();
  } catch(e) {
    errEl.textContent = 'Connection error. Please try again.';
  } finally {
    btn.textContent = 'Unlock Profile';
    btn.disabled = false;
  }
}

async function doLogout() {
  // Always switch to landing no matter what — wrap everything in try/catch
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch(e) {}

  // Wipe state immediately
  currentUser = null; subjects = []; notes = [];

  // Switch view FIRST — this is the most important step
  showView('landing');

  // Then clean up everything else safely
  try { closeProfileMenu(); } catch(e) {}
  try {
    ['subjectModal','noteModal','profileModal','confirmModal','deleteAccountModal']
      .forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('open'); });
  } catch(e) {}
  try {
    const sidebar = document.getElementById('notesSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  } catch(e) {}
  try {
    pausePomodoro();
    const fab = document.getElementById('pomodoroFab');
    const widget = document.getElementById('pomodoroWidget');
    if (fab) fab.style.display = 'none';
    if (widget) widget.style.display = 'none';
  } catch(e) {}
  try {
    // Remove subject cards but KEEP the emptyState div inside the grid
    const grid = document.getElementById('subjectsGrid');
    if (grid) {
      // Remove all children except emptyState
      Array.from(grid.children).forEach(child => {
        if (child.id !== 'emptyState') child.remove();
      });
      // Make sure emptyState is inside grid and hidden
      let empty = document.getElementById('emptyState');
      if (empty && !grid.contains(empty)) grid.appendChild(empty);
      if (empty) empty.style.display = 'none';
    }
    const strip = document.getElementById('subjectProgressStrip');
    if (strip) strip.innerHTML = '';
    const fill = document.getElementById('overallFill');
    if (fill) fill.style.width = '0%';
    const pct = document.getElementById('overallPct');
    if (pct) pct.textContent = '0%';
    const notesList = document.getElementById('notesList');
    if (notesList) notesList.innerHTML = '';
    const badge = document.getElementById('notesBadge');
    if (badge) badge.textContent = '0';
    const chip = document.getElementById('countdownChip');
    if (chip) chip.style.display = 'none';
  } catch(e) {}

  // Reload profiles on landing
  try { await loadProfiles(); } catch(e) {}
}

function openDeleteAccountModal() {
  closeProfileMenu();
  document.getElementById('deleteAccountPw').value = '';
  document.getElementById('deleteAccountError').textContent = '';
  const btn = document.getElementById('deleteAccountBtn');
  btn.textContent = 'Yes, Delete My Profile';
  btn.disabled = false;
  openModal('deleteAccountModal');
  setTimeout(() => document.getElementById('deleteAccountPw').focus(), 150);
}

async function confirmDeleteAccount() {
  const pw    = document.getElementById('deleteAccountPw').value;
  const errEl = document.getElementById('deleteAccountError');
  const btn   = document.getElementById('deleteAccountBtn');
  errEl.textContent = '';

  if (!pw) { errEl.textContent = 'Please enter your password.'; return; }

  btn.textContent = 'Deleting…';
  btn.disabled = true;

  try {
    const r = await fetch(`/api/profiles/${currentUser.id}/delete-account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const d = await r.json();
    if (!r.ok) {
      errEl.textContent = d.error || 'Something went wrong.';
      btn.textContent = 'Yes, Delete My Profile';
      btn.disabled = false;
      return;
    }
    // Success — wipe state and go back to landing
    closeModal('deleteAccountModal');
    currentUser = null; subjects = []; notes = [];

    // Clean up tracker UI before switching
    try { resetPomodoro(); } catch(e) {}
    try { pausePomodoro(); } catch(e) {}
    try { document.getElementById('pomodoroFab').style.display = 'none'; } catch(e) {}
    try { document.getElementById('pomodoroWidget').style.display = 'none'; } catch(e) {}
    try { document.getElementById('countdownChip').style.display = 'none'; } catch(e) {}
    try {
      const grid = document.getElementById('subjectsGrid');
      if (grid) Array.from(grid.children).forEach(c => { if (c.id !== 'emptyState') c.remove(); });
      document.getElementById('subjectProgressStrip').innerHTML = '';
      document.getElementById('overallFill').style.width = '0%';
      document.getElementById('overallPct').textContent = '0%';
      document.getElementById('notesList').innerHTML = '';
      document.getElementById('notesBadge').textContent = '0';
    } catch(e) {}

    // Clear motivation cache for this user
    // Clear motivation cache for this user on logout
    try { const todayK = getTodayKey(); const uid = currentUser ? currentUser.id : 'anon'; localStorage.removeItem('bprep_motiv_' + uid + '_' + todayK); } catch(e) {}

    showView('landing');
    await loadProfiles();
    showToast('Profile deleted successfully.');
  } catch(e) {
    errEl.textContent = 'Connection error. Please try again.';
    btn.textContent = 'Yes, Delete My Profile';
    btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  TRACKER — Enter
// ══════════════════════════════════════════════════════════════
async function enterTrackerWithData() {
  // Data (subjects + notes) already in memory — just render, no fetches
  try { updateHeaderProfile(); } catch(e) {}
  try { updateCountdown(); }     catch(e) {}
  try { updateProUI(); }         catch(e) {}
  try { updateStreakUI(); }      catch(e) {}
  showView('tracker');
  try { showPomodoroFab(); }     catch(e) {}
  try { renderSubjectsGrid(); renderProgressOverview(); } catch(e) {}
  try { renderNotes(); }         catch(e) {}
  try { fetchMotivation(); }     catch(e) {}
}

function isPro() {
  return currentUser && currentUser.is_pro === true;
}

function updateStreakUI() {
  const streak = currentUser && currentUser.streak ? parseInt(currentUser.streak) : 0;
  const chip   = document.getElementById('streakChip');
  const count  = document.getElementById('streakCount');
  if (!chip) return;
  if (streak > 0) {
    chip.style.display = 'flex';
    count.textContent  = streak;
    // Add fire animation for milestone streaks
    chip.classList.toggle('streak-milestone', streak >= 7);
  } else {
    chip.style.display = 'none';
  }
}

function updateStreakFromResponse(data) {
  // Called after topic/subsection is marked done — update streak from server
  if (data && data.streak !== undefined) {
    if (currentUser) currentUser.streak = data.streak;
    updateStreakUI();
  }
}

function updateProUI() {
  const pro         = isPro();
  const plan        = currentUser && currentUser.plan;
  const planExpires = currentUser && currentUser.plan_expires ? new Date(currentUser.plan_expires) : null;
  const created     = currentUser && currentUser.created_at  ? new Date(currentUser.created_at)   : null;

  // Pro badge in header — show for pro but NOT for trial
  const badge = document.getElementById('proBadge');
  if (badge) badge.style.display = (pro && plan !== 'trial') ? 'inline-flex' : 'none';

  // Trial banner — show if on trial plan with days remaining
  const trialBanner = document.getElementById('trialBanner');
  const freeBanner  = document.getElementById('basicBanner');

  if (trialBanner && freeBanner) {
    const isTrial = plan === 'trial' && !currentUser.is_paused;

    if (isTrial && planExpires) {
      // Calculate days remaining from plan_expires
      const msLeft   = planExpires.getTime() - Date.now();
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

      if (daysLeft > 0) {
        const dayWord = daysLeft === 1 ? 'day' : 'days';
        trialBanner.innerHTML = `
          🎉 You're on <strong>Pro Trial</strong> —
          <span style="color:var(--gold);font-weight:800">${daysLeft} ${dayWord} remaining</span>.
          After trial: Basic ₱70/year or Pro ₱100 / 4 months.
          <a href="https://www.facebook.com/boardpreph/" target="_blank"
             style="color:var(--gold);font-weight:700;margin-left:4px;text-decoration:none">Contact us →</a>
        `;
        trialBanner.style.display = 'flex';
      } else {
        trialBanner.style.display = 'none';
      }
    } else {
      trialBanner.style.display = 'none';
    }

    freeBanner.style.display = (!pro && plan !== 'trial') ? 'flex' : 'none';
  }

  // PDF section
  const pdfPro  = document.getElementById('pdfProSection');
  const pdfFree = document.getElementById('pdfFreeSection');
  if (pdfPro)  pdfPro.style.display  = pro ? 'block' : 'none';
  if (pdfFree) pdfFree.style.display = pro ? 'none'  : 'block';
}

async function enterTracker() {
  // Fetch subjects + notes then render (used after login/register)
  try { updateHeaderProfile(); } catch(e) {}
  try { updateCountdown(); }     catch(e) {}
  try { updateProUI(); }         catch(e) {}
  try { updateStreakUI(); }      catch(e) {}
  showView('tracker');
  try { showPomodoroFab(); }     catch(e) {}
  try {
    // Use me-full to get everything in one request
    const r = await fetch('/api/auth/me-full', { credentials: 'include' });
    if (r.ok) {
      const full = await r.json();
      // Update currentUser with fresh data including streak
      if (full.user) currentUser = full.user;
      subjects = full.subjects || [];
      notes    = full.notes    || [];
      renderSubjectsGrid(); renderProgressOverview();
      renderNotes();
    } else {
      await Promise.all([loadSubjects(), loadNotes()]);
    }
  } catch(e) {
    console.error('Error loading data:', e);
    try { await Promise.all([loadSubjects(), loadNotes()]); } catch(e2) {}
  }
  try { fetchMotivation(); } catch(e) {}
  try { updateProUI(); }     catch(e) {}
  try { updateStreakUI(); }  catch(e) {}
}

function updateHeaderProfile() {
  if (!currentUser) return;
  const nameEl   = document.getElementById('headerName');
  const avatarEl = document.getElementById('headerAvatar');
  nameEl.textContent = currentUser.display_name;
  if (currentUser.avatar) {
    avatarEl.innerHTML = `<img src="${currentUser.avatar}" alt="">`;
  } else {
    avatarEl.innerHTML = `<span style="font-size:.9rem">${currentUser.display_name[0].toUpperCase()}</span>`;
  }
}

function updateCountdown() {
  const chip  = document.getElementById('countdownChip');
  const days  = document.getElementById('countdownDays');
  const label = document.getElementById('countdownLabel');
  const sub   = chip ? chip.querySelector('.countdown-sub') : null;
  if (!chip) return;

  const examDate = currentUser?.exam_date;
  if (!examDate) { chip.style.display = 'none'; return; }

  const today = new Date(); today.setHours(0,0,0,0);
  const exam  = new Date(examDate); exam.setHours(0,0,0,0);
  const diff  = Math.round((exam - today) / 86400000);

  chip.style.display = 'flex';
  chip.className = 'motivation-countdown';

  if (diff < 0) {
    days.textContent  = '🎉';
    label.textContent = 'Board exam passed!';
    if (sub) sub.textContent = 'Congratulations!';
    chip.classList.add('done');
  } else if (diff === 0) {
    days.textContent  = 'TODAY';
    label.textContent = 'Board exam is today!';
    if (sub) sub.textContent = 'Good luck! Kaya mo yan! 💪';
    chip.classList.add('urgent');
  } else if (diff <= 7) {
    days.textContent  = diff;
    label.textContent = `day${diff !== 1 ? 's' : ''} to board exam`;
    if (sub) sub.textContent = '⚠️ Final stretch — focus up!';
    chip.classList.add('urgent');
  } else {
    days.textContent  = diff;
    label.textContent = 'days to board exam';
    if (sub) sub.textContent = '🗓️ Tap to update exam date';
  }
}

// ══════════════════════════════════════════════════════════════
//  PROFILE MENU
// ══════════════════════════════════════════════════════════════
function toggleProfileMenu() {
  const menu = document.getElementById('profileMenu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}
function closeProfileMenu() {
  document.getElementById('profileMenu').style.display = 'none';
}
document.addEventListener('click', e => {
  if (!e.target.closest('.profile-pill') && !e.target.closest('.profile-menu')) closeProfileMenu();
});

// ══════════════════════════════════════════════════════════════
//  PROFILE SETTINGS MODAL
// ══════════════════════════════════════════════════════════════
function openProfileModal() {
  closeProfileMenu();
  document.getElementById('profileUsername').value    = currentUser.username;
  document.getElementById('profileDisplayName').value = currentUser.display_name;
  document.getElementById('profileCurrentPw').value   = '';
  document.getElementById('profileNewPw').value       = '';
  document.getElementById('profile-error').textContent = '';
  document.getElementById('profileExamDate').value    = currentUser.exam_date || '';
  avatarDataUrl = null;
  // Show current avatar
  const prev = document.getElementById('avatarPreview');
  const removeBtn = document.getElementById('avatarRemoveBtn');
  if (currentUser.avatar) {
    prev.innerHTML = `<img src="${currentUser.avatar}" alt="">`;
    removeBtn.style.display = 'inline-flex';
  } else {
    prev.innerHTML = `<span>${currentUser.display_name[0].toUpperCase()}</span>`;
    removeBtn.style.display = 'none';
  }
  openModal('profileModal');
}

function previewAvatar(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    avatarDataUrl = e.target.result;
    document.getElementById('avatarPreview').innerHTML = `<img src="${avatarDataUrl}" alt="">`;
    document.getElementById('avatarRemoveBtn').style.display = 'inline-flex';
  };
  reader.readAsDataURL(file);
}

function removeAvatarPreview() {
  avatarDataUrl = 'remove';
  document.getElementById('avatarPreview').innerHTML = `<span>${currentUser.display_name[0].toUpperCase()}</span>`;
  document.getElementById('avatarRemoveBtn').style.display = 'none';
  document.getElementById('avatarInput').value = '';
}

async function saveProfile() {
  const errEl = document.getElementById('profile-error');
  errEl.textContent = '';
  const uid = currentUser.id;
  const btn = document.querySelector('#profileModal .btn-primary');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  try {
    // Handle avatar changes
    if (avatarDataUrl === 'remove') {
      const r = await fetch(`/api/profiles/${uid}/avatar`, { method: 'DELETE' });
      const text = await r.text();
      let d;
      try { d = JSON.parse(text); } catch(e) { errEl.textContent = 'Server error removing picture.'; return; }
      if (!r.ok) { errEl.textContent = d.error || `Error ${r.status} removing picture.`; return; }
      currentUser = d;
    } else if (avatarDataUrl && avatarDataUrl !== null) {
      const fileInput = document.getElementById('avatarInput');
      if (fileInput.files[0]) {
        const form = new FormData();
        form.append('avatar', fileInput.files[0]);
        const r = await fetch(`/api/profiles/${uid}/avatar`, { method: 'POST', body: form });
        const d = await r.json();
        if (!r.ok) { errEl.textContent = d.error; return; }
        currentUser = d;
      }
    }

    // Update username / display name / password / exam date
    const examDateVal = document.getElementById('profileExamDate').value;
    const body = {
      username:     document.getElementById('profileUsername').value.trim().toLowerCase(),
      display_name: document.getElementById('profileDisplayName').value.trim(),
      exam_date:    examDateVal || null
    };
    const newPw = document.getElementById('profileNewPw').value;
    if (newPw) {
      body.new_password     = newPw;
      body.current_password = document.getElementById('profileCurrentPw').value;
    }

    const avatarBeforeSave = currentUser.avatar;
    const r2 = await fetch(`/api/profiles/${uid}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d2 = await r2.json();
    if (!r2.ok) { errEl.textContent = d2.error; return; }

    // Merge + preserve avatar state
    currentUser = { ...currentUser, ...d2 };
    if (avatarDataUrl === 'remove') {
      currentUser.avatar = null;
    } else if (avatarDataUrl === null) {
      currentUser.avatar = avatarBeforeSave;
    }

    updateHeaderProfile();
    updateCountdown();
    closeModal('profileModal');
    showToast('Profile updated! ✅');

  } catch(e) {
    errEl.textContent = 'Connection error. Please try again.';
  } finally {
    if (btn) { btn.textContent = 'Save Changes'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════════════════════════
//  SUBJECTS
// ══════════════════════════════════════════════════════════════
async function loadSubjects() {
  const r = await fetch(`/api/profiles/${currentUser.id}/subjects`);
  subjects = await r.json();
  renderSubjectsGrid();
  renderProgressOverview();
}

async function loadNotes() {
  const r = await fetch(`/api/profiles/${currentUser.id}/notes`);
  notes = await r.json();
  renderNotes();
}

function apiBase() { return `/api/profiles/${currentUser.id}`; }

function renderSubjectsGrid() {
  const grid  = document.getElementById('subjectsGrid');
  if (!grid) return;

  // Always remove subject cards but never emptyState
  Array.from(grid.children).forEach(child => {
    if (child.id !== 'emptyState') child.remove();
  });

  // Ensure emptyState exists inside the grid
  let empty = document.getElementById('emptyState');
  if (!empty) {
    // Recreate it if somehow it got destroyed
    empty = document.createElement('div');
    empty.id = 'emptyState';
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">🎓</div>
      <h2>Start your review journey</h2>
      <p>Add your first board exam subject to begin tracking your progress.</p>
      <button class="btn-primary" onclick="openAddSubjectModal()">+ Add Your First Subject</button>`;
    grid.appendChild(empty);
  } else if (!grid.contains(empty)) {
    grid.appendChild(empty);
  }

  if (subjects.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  subjects.forEach(s => grid.appendChild(buildSubjectCard(s)));
}

function buildSubjectCard(subject) {
  const { total, done } = subjectProgress(subject);
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const card = document.createElement('div');
  card.className = 'subject-card';
  card.id = `subject-${subject.id}`;
  card.innerHTML = `
    <div class="card-header">
      <div class="card-color-bar" style="background:${subject.color}"></div>
      <div class="card-header-info">
        <div class="card-title">${esc(subject.name)}</div>
        <div class="card-progress-row">
          <div class="card-bar-wrap">
            <div class="card-bar-fill" id="bar-${subject.id}" style="background:${subject.color}; width:${pct}%"></div>
          </div>
          <span class="card-pct" id="pct-${subject.id}" style="color:${subject.color}">${pct}%</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-icon btn-quiz" title="Start Quiz" onclick="openFlashcardQuiz('${subject.id}','${subject.name}','${subject.color}')">🎴 Quiz</button>
        <button class="btn-icon" title="Edit" onclick="openEditSubjectModal('${subject.id}')">✏️</button>
        <button class="btn-icon" title="Delete" onclick="confirmDelete('subject','${subject.id}')">🗑️</button>
      </div>
    </div>
    <div class="card-body" id="card-body-${subject.id}">
      <div id="ss-list-${subject.id}">
        ${subject.subsections.map(ss => buildSubsectionHTML(subject.id, ss, subject.name, subject.color)).join('')}
      </div>
      <div class="add-subsection-row">
        <input class="inline-input" id="ss-input-${subject.id}" placeholder="Add sub-subject…"
               onkeydown="handleSSEnter(event,'${subject.id}')"/>
        <button class="btn-add-inline" onclick="quickAddSubsection('${subject.id}')">+ Add</button>
      </div>
    </div>`;
  return card;
}

function buildSubsectionHTML(subjectId, ss, subjectName, subjectColor) {
  const topicTotal = ss.topics.length;
  const topicDone  = ss.topics.filter(t => t.done).length;
  const pct = topicTotal === 0 ? (ss.done ? 100 : 0) : Math.round((topicDone / topicTotal) * 100);
  const cbClass   = ss.done ? 'checked' : (topicDone > 0 ? 'partial' : '');
  const checkMark = ss.done ? '✓' : (topicDone > 0 ? '–' : '');
  return `
  <div class="subsection-item" id="ss-${ss.id}">
    <div class="subsection-header" onclick="toggleSubsection('${ss.id}')">
      <div class="custom-checkbox ${cbClass}" id="ss-cb-${ss.id}"
           onclick="event.stopPropagation(); toggleSubsectionDone('${subjectId}','${ss.id}')">${checkMark}</div>
      <span class="subsection-name ${ss.done ? 'done-text':''}" id="ss-name-${ss.id}">${esc(ss.name)}</span>
      <span class="subsection-sub-pct" id="ss-pct-${ss.id}">${pct}%</span>
      <div class="sub-actions">
        <button class="btn-icon" title="Quiz this sub-subject"
                onclick="event.stopPropagation(); openFlashcardQuiz('${subjectId}','${subjectName}','${subjectColor}','${ss.id}','${esc(ss.name)}')">🎴</button>
        <button class="btn-icon" onclick="event.stopPropagation(); confirmDelete('subsection','${subjectId}','${ss.id}')">🗑️</button>
      </div>
      <span class="subsection-toggle" id="sst-${ss.id}">▼</span>
    </div>
    <div class="subsection-body" id="ssb-${ss.id}" style="display:none">
      <div id="topic-list-${ss.id}">
        ${ss.topics.map(t => buildTopicHTML(subjectId, ss.id, t)).join('')}
      </div>
      <div class="add-topic-row">
        <input class="inline-input" id="t-input-${ss.id}" placeholder="Add topic…"
               onkeydown="handleTopicEnter(event,'${subjectId}','${ss.id}')"/>
        <button class="btn-add-inline" onclick="quickAddTopic('${subjectId}','${ss.id}')">+ Add</button>
      </div>
    </div>
  </div>`;
}

function buildTopicHTML(subjectId, ssId, t) {
  const hasNote = t.note && t.note.trim().length > 0;
  return `
  <div class="topic-item" id="t-${t.id}">
    <div class="topic-checkbox ${t.done ? 'checked':''}" id="t-cb-${t.id}"
         onclick="toggleTopicDone('${subjectId}','${ssId}','${t.id}')">${t.done ? '✓':''}</div>
    <span class="topic-name ${t.done ? 'done-text':''}" id="t-name-${t.id}">${esc(t.name)}</span>
    <button class="btn-icon topic-note-btn ${hasNote ? 'has-note' : ''}"
            id="tnote-btn-${t.id}"
            title="${hasNote ? 'Edit note' : 'Add note'}"
            onclick="toggleTopicNote('${subjectId}','${ssId}','${t.id}')">📝</button>
    <button class="btn-icon" onclick="confirmDelete('topic','${subjectId}','${ssId}','${t.id}')">🗑️</button>
  </div>
  <div class="topic-note-row" id="tnote-${t.id}" style="display:none">
    <textarea class="topic-note-input" id="tnote-text-${t.id}"
              placeholder="Add a definition, formula, or key concept for this topic…"
              onblur="saveTopicNote('${subjectId}','${ssId}','${t.id}')"
              onkeydown="if(event.key==='Escape') closeTopicNote('${t.id}')"
    >${esc(t.note || '')}</textarea>
    <div class="topic-note-actions">
      <span class="topic-note-hint">Tab or click outside to save · Esc to close</span>
      <button class="btn-add-inline" onclick="saveTopicNote('${subjectId}','${ssId}','${t.id}')">Save</button>
    </div>
  </div>`;
}

// ── Progress ──────────────────────────────────────────────────
function subjectProgress(s) {
  let total = 0, done = 0;
  s.subsections.forEach(ss => {
    if (!ss.topics.length) { total++; if (ss.done) done++; }
    else { total += ss.topics.length; done += ss.topics.filter(t => t.done).length; }
  });
  return { total, done };
}

function refreshCardProgress(subjectId) {
  const s = subjects.find(x => x.id === subjectId);
  if (!s) return;
  const { total, done } = subjectProgress(s);
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const bar = document.getElementById(`bar-${subjectId}`);
  const lbl = document.getElementById(`pct-${subjectId}`);
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = pct + '%';
  refreshOverallProgress();
}

function renderProgressOverview() {
  const strip = document.getElementById('subjectProgressStrip');
  strip.innerHTML = '';
  subjects.forEach(s => {
    const { total, done } = subjectProgress(s);
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const chip = document.createElement('div');
    chip.className = 'subject-chip';
    chip.id = `chip-${s.id}`;
    chip.innerHTML = `
      <div class="chip-dot" style="background:${s.color}"></div>
      <span style="font-size:0.78rem;color:var(--text2)">${esc(s.name)}</span>
      <div class="chip-bar-wrap"><div class="chip-bar-fill" id="chip-bar-${s.id}" style="background:${s.color};width:${pct}%"></div></div>
      <span class="chip-pct" id="chip-pct-${s.id}" style="color:${s.color}">${pct}%</span>`;
    strip.appendChild(chip);
  });
  refreshOverallProgress();
}

function refreshOverallProgress() {
  let totalAll = 0, doneAll = 0;
  subjects.forEach(s => {
    const { total, done } = subjectProgress(s);
    totalAll += total; doneAll += done;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const cb = document.getElementById(`chip-bar-${s.id}`);
    const cp = document.getElementById(`chip-pct-${s.id}`);
    if (cb) cb.style.width = pct + '%';
    if (cp) cp.textContent = pct + '%';
  });
  const overall = totalAll === 0 ? 0 : Math.round((doneAll / totalAll) * 100);
  document.getElementById('overallFill').style.width = overall + '%';
  document.getElementById('overallPct').textContent  = overall + '%';
}

// ── Subject CRUD ──────────────────────────────────────────────
function openAddSubjectModal() {
  ctx = { mode: 'add' };
  document.getElementById('subjectModalTitle').textContent = 'Add Subject';
  document.getElementById('subjectNameInput').value = '';
  selectColor('subjectColorPicker', SUBJECT_COLORS[0]);
  openModal('subjectModal');
  setTimeout(() => document.getElementById('subjectNameInput').focus(), 100);
}
function openEditSubjectModal(id) {
  const s = subjects.find(x => x.id === id);
  if (!s) return;
  ctx = { mode: 'edit', id };
  document.getElementById('subjectModalTitle').textContent = 'Edit Subject';
  document.getElementById('subjectNameInput').value = s.name;
  selectColor('subjectColorPicker', s.color);
  openModal('subjectModal');
}
// ── Shared helper: swap a tempId → realId across DOM + state ──
function _swapTempId(root, tempId, realId) {
  if (!root) return;
  // Swap IDs
  root.querySelectorAll('[id]').forEach(el => {
    el.id = el.id.replaceAll(tempId, realId);
  });
  // Swap all inline event handlers that reference the tempId
  ['onclick', 'onkeydown', 'onkeyup', 'oninput'].forEach(attr => {
    root.querySelectorAll(`[${attr}]`).forEach(el => {
      el.setAttribute(attr, el.getAttribute(attr).replaceAll(tempId, realId));
    });
  });
}

async function saveSubject() {
  const name  = document.getElementById('subjectNameInput').value.trim();
  if (!name) { showToast('Please enter a subject name'); return; }
  const color = getSelectedColor('subjectColorPicker') || SUBJECT_COLORS[0];

  closeModal('subjectModal'); // close immediately — feels instant

  if (ctx.mode === 'add') {
    // → delegate to addSubject() which handles optimistic UI
    addSubject(name, color);

  } else {
    // ── OPTIMISTIC EDIT ──────────────────────────────────────
    const idx  = subjects.findIndex(x => x.id === ctx.id);
    const prev = idx !== -1 ? { ...subjects[idx] } : null;

    // 1. Update local state immediately
    if (idx !== -1) { subjects[idx].name = name; subjects[idx].color = color; }

    // 2. Update DOM immediately — user sees change NOW
    const card = document.getElementById(`subject-${ctx.id}`);
    if (card) {
      card.querySelector('.card-title').textContent = name;
      card.querySelector('.card-color-bar').style.background = color;
      card.querySelector('.card-bar-fill').style.background  = color;
      card.querySelector('.card-pct').style.color = color;
    }
    const chip = document.getElementById(`chip-${ctx.id}`);
    if (chip) {
      const dot = chip.querySelector('.chip-dot');
      const bar = chip.querySelector('[id^="chip-bar-"]');
      const pct = chip.querySelector('[id^="chip-pct-"]');
      const lbl = chip.querySelector('span:not(.chip-pct)');
      if (dot) dot.style.background = color;
      if (bar) bar.style.background = color;
      if (pct) pct.style.color = color;
      if (lbl) lbl.textContent = name;
    }
    showToast('Subject updated! ✅');

    // 3. Sync to server in background
    try {
      const r = await fetch(`${apiBase()}/subjects/${ctx.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
      });
      if (!r.ok) throw new Error('Server error');
    } catch(e) {
      // 4. Rollback — restore previous values
      if (prev && idx !== -1) subjects[idx] = prev;
      const rollCard = document.getElementById(`subject-${ctx.id}`);
      if (rollCard && prev) {
        rollCard.querySelector('.card-title').textContent = prev.name;
        rollCard.querySelector('.card-color-bar').style.background = prev.color;
        rollCard.querySelector('.card-bar-fill').style.background  = prev.color;
        rollCard.querySelector('.card-pct').style.color = prev.color;
      }
      showToast('❌ Failed to update subject. Changes reverted.');
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  OPTIMISTIC ADD HELPERS
// ══════════════════════════════════════════════════════════════

async function addSubject(name, color) {
  // 1. Optimistic — create temp + update state + render instantly
  const tempId      = 'temp_' + Date.now();
  const tempSubject = { id: tempId, name, color, subsections: [] };
  subjects.push(tempSubject);

  const _es = document.getElementById('emptyState');
  if (_es) _es.style.display = 'none';
  document.getElementById('subjectsGrid').appendChild(buildSubjectCard(tempSubject));
  _addChipToStrip(tempSubject);

  // 2. Background API call
  try {
    const r = await fetch(`${apiBase()}/subjects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color })
    });
    if (!r.ok) throw new Error('Server error');
    const real = await r.json();

    // 3. Silently promote temp → real (swap IDs in state + DOM)
    const idx = subjects.findIndex(x => x.id === tempId);
    if (idx !== -1) subjects[idx] = { ...real, subsections: [] };

    const cardEl = document.getElementById(`subject-${tempId}`);
    const chipEl = document.getElementById(`chip-${tempId}`);
    if (cardEl) { cardEl.id = `subject-${real.id}`; _swapTempId(cardEl, tempId, real.id); }
    if (chipEl) {
      chipEl.id = `chip-${real.id}`;
      chipEl.querySelectorAll('[id]').forEach(el => { el.id = el.id.replaceAll(tempId, real.id); });
    }
    showToast('Subject added! ✅');

  } catch(e) {
    // 4. Rollback
    subjects = subjects.filter(x => x.id !== tempId);
    document.getElementById(`subject-${tempId}`)?.remove();
    document.getElementById(`chip-${tempId}`)?.remove();
    if (!subjects.length) {
      const g = document.getElementById('subjectsGrid');
      const em = document.getElementById('emptyState');
      if (g && em) { if (!g.contains(em)) g.appendChild(em); em.style.display = 'block'; }
    }
    showToast('❌ Failed to add subject. Please try again.');
  }
}

// Helper — add a progress chip to the strip
function _addChipToStrip(s) {
  const strip = document.getElementById('subjectProgressStrip');
  if (!strip) return;
  const chip = document.createElement('div');
  chip.className = 'subject-chip'; chip.id = `chip-${s.id}`;
  chip.innerHTML = `
    <div class="chip-dot" style="background:${s.color}"></div>
    <span style="font-size:0.78rem;color:var(--text2)">${esc(s.name)}</span>
    <div class="chip-bar-wrap"><div class="chip-bar-fill" id="chip-bar-${s.id}" style="background:${s.color};width:0%"></div></div>
    <span class="chip-pct" id="chip-pct-${s.id}" style="color:${s.color}">0%</span>`;
  strip.appendChild(chip);
}

// ── Subsections ───────────────────────────────────────────────
async function quickAddSubsection(subjectId) {
  const input = document.getElementById(`ss-input-${subjectId}`);
  const name  = input.value.trim();
  if (!name) return;
  input.value = '';
  addSubSubject(subjectId, name);
}
function handleSSEnter(e, id) { if (e.key === 'Enter') quickAddSubsection(id); }

async function addSubSubject(subjectId, name) {
  const s      = subjects.find(x => x.id === subjectId);
  if (!s) return;

  // 1. Optimistic — create temp + update state + render instantly
  const tempId = 'temp_' + Date.now();
  const tempSS = { id: tempId, name, done: false, topics: [] };
  s.subsections.push(tempSS);
  const list = document.getElementById(`ss-list-${subjectId}`);
  if (list) list.insertAdjacentHTML('beforeend', buildSubsectionHTML(subjectId, tempSS));
  refreshCardProgress(subjectId);

  // 2. Background API call
  try {
    const r = await fetch(`${apiBase()}/subjects/${subjectId}/subsections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!r.ok) throw new Error('Server error');
    const real = await r.json();

    // 3. Silently promote temp → real
    const idx = s.subsections.findIndex(x => x.id === tempId);
    if (idx !== -1) s.subsections[idx] = { ...real, topics: [] };
    const el = document.getElementById(`ss-${tempId}`);
    if (el) { el.id = `ss-${real.id}`; _swapTempId(el, tempId, real.id); }

  } catch(e) {
    // 4. Rollback
    s.subsections = s.subsections.filter(x => x.id !== tempId);
    document.getElementById(`ss-${tempId}`)?.remove();
    refreshCardProgress(subjectId);
    showToast('❌ Failed to add sub-subject. Please try again.');
  }
}

async function toggleSubsectionDone(subjectId, ssId) {
  const s  = subjects.find(x => x.id === subjectId);
  const ss = s?.subsections.find(x => x.id === ssId);
  if (!ss) return;

  ss.done = !ss.done;
  const nowDone = ss.done;

  // ── Update subsection UI ──────────────────────────────────────
  const cb = document.getElementById(`ss-cb-${ssId}`);
  const nm = document.getElementById(`ss-name-${ssId}`);
  const pe = document.getElementById(`ss-pct-${ssId}`);
  if (cb) { cb.className = 'custom-checkbox' + (nowDone ? ' checked' : ''); cb.textContent = nowDone ? '✓' : ''; }
  if (nm) nm.className = 'subsection-name' + (nowDone ? ' done-text' : '');

  // ── Cascade to all topics ────────────────────────────────────
  ss.topics.forEach(t => {
    t.done = nowDone;
    const tcb = document.getElementById(`t-cb-${t.id}`);
    const tnm = document.getElementById(`t-name-${t.id}`);
    if (tcb) { tcb.className = 'topic-checkbox' + (nowDone ? ' checked' : ''); tcb.textContent = nowDone ? '✓' : ''; }
    if (tnm) tnm.className = 'topic-name' + (nowDone ? ' done-text' : '');
  });

  // Update subsection % display
  if (pe) pe.textContent = (nowDone ? 100 : 0) + '%';
  refreshCardProgress(subjectId);

  // ── Save subsection to DB ─────────────────────────────────────
  fetch(`${apiBase()}/subjects/${subjectId}/subsections/${ssId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ done: nowDone })
  }).then(() => {
    if (nowDone) {
      fetch('/api/auth/me').then(r => r.json()).then(u => {
        if (u && u.streak !== undefined) { currentUser.streak = u.streak; updateStreakUI(); }
      }).catch(() => {});
    }
  }).catch(() => {});

  // ── Save each topic to DB (fire all in parallel) ──────────────
  ss.topics.forEach(t => {
    fetch(`${apiBase()}/subjects/${subjectId}/subsections/${ssId}/topics/${t.id}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ done: nowDone })
    });
  });
}

// ── Topics ────────────────────────────────────────────────────
async function quickAddTopic(subjectId, ssId) {
  const input = document.getElementById(`t-input-${ssId}`);
  const name  = input.value.trim();
  if (!name) return;
  input.value = '';
  addTopic(subjectId, ssId, name);
}
function handleTopicEnter(e, sid, ssid) { if (e.key === 'Enter') quickAddTopic(sid, ssid); }

async function addTopic(subjectId, ssId, name) {
  const s  = subjects.find(x => x.id === subjectId);
  const ss = s?.subsections.find(x => x.id === ssId);
  if (!ss) return;

  // 1. Optimistic — create temp + update state + render instantly
  const tempId = 'temp_' + Date.now();
  const tempT  = { id: tempId, name, done: false };
  ss.topics.push(tempT);

  const list = document.getElementById(`topic-list-${ssId}`);
  if (list) list.insertAdjacentHTML('beforeend', buildTopicHTML(subjectId, ssId, tempT));

  // Open subsection body if closed
  const body   = document.getElementById(`ssb-${ssId}`);
  const toggle = document.getElementById(`sst-${ssId}`);
  if (body)   body.style.display = 'block';
  if (toggle) toggle.classList.add('open');

  // Update subsection % display
  const pe = document.getElementById(`ss-pct-${ssId}`);
  if (pe) {
    const d = ss.topics.filter(tp => tp.done).length;
    pe.textContent = Math.round((d / ss.topics.length) * 100) + '%';
  }
  refreshCardProgress(subjectId);

  // 2. Background API call
  try {
    const r = await fetch(`${apiBase()}/subjects/${subjectId}/subsections/${ssId}/topics`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!r.ok) throw new Error('Server error');
    const real = await r.json();

    // 3. Silently promote temp → real
    const idx = ss.topics.findIndex(x => x.id === tempId);
    if (idx !== -1) ss.topics[idx] = real;
    const el = document.getElementById(`t-${tempId}`);
    if (el) { el.id = `t-${real.id}`; _swapTempId(el, tempId, real.id); }

  } catch(e) {
    // 4. Rollback
    ss.topics = ss.topics.filter(x => x.id !== tempId);
    document.getElementById(`t-${tempId}`)?.remove();
    refreshCardProgress(subjectId);
    showToast('❌ Failed to add topic. Please try again.');
  }
}

async function toggleTopicDone(subjectId, ssId, topicId) {
  const s  = subjects.find(x => x.id === subjectId);
  const ss = s?.subsections.find(x => x.id === ssId);
  const t  = ss?.topics.find(x => x.id === topicId);
  if (!t) return;
  t.done = !t.done;
  const cb = document.getElementById(`t-cb-${topicId}`);
  const nm = document.getElementById(`t-name-${topicId}`);
  if (cb) { cb.className = 'topic-checkbox' + (t.done ? ' checked' : ''); cb.textContent = t.done ? '✓' : ''; }
  if (nm) nm.className = 'topic-name' + (t.done ? ' done-text' : '');
  const td = ss.topics.filter(tp => tp.done).length, tt = ss.topics.length;
  const ssCb = document.getElementById(`ss-cb-${ssId}`);
  const ssPe = document.getElementById(`ss-pct-${ssId}`);
  const ssNm = document.getElementById(`ss-name-${ssId}`);
  if (ssPe) ssPe.textContent = Math.round((td / tt) * 100) + '%';
  // Track previous ss.done to detect auto-change
  const prevSsDone = ss.done;

  if (td === tt && tt > 0) {
    ss.done = true;
    if (ssCb) { ssCb.className = 'custom-checkbox checked'; ssCb.textContent = '✓'; }
    if (ssNm) ssNm.className = 'subsection-name done-text';
  } else if (td === 0) {
    ss.done = false;
    if (ssCb) { ssCb.className = 'custom-checkbox'; ssCb.textContent = ''; }
    if (ssNm) ssNm.className = 'subsection-name';
  } else {
    ss.done = false;
    if (ssCb) { ssCb.className = 'custom-checkbox partial'; ssCb.textContent = '–'; }
    if (ssNm) ssNm.className = 'subsection-name';
  }
  refreshCardProgress(subjectId);

  // Always save the topic's done state and update streak
  fetch(`${apiBase()}/subjects/${subjectId}/subsections/${ssId}/topics/${topicId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ done: t.done })
  }).then(r => r.ok ? r.json() : null).then(data => {
    if (data && t.done) {
      // Refresh currentUser streak from server
      fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json()).then(u => {
        if (u && u.streak !== undefined) { currentUser.streak = u.streak; updateStreakUI(); }
      }).catch(() => {});
    }
  }).catch(() => {});

  // If subsection done state changed automatically, save that too
  if (ss.done !== prevSsDone) {
    fetch(`${apiBase()}/subjects/${subjectId}/subsections/${ssId}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ done: ss.done })
    });
  }
}

// ══════════════════════════════════════════════════════════════
//  NOTES
// ══════════════════════════════════════════════════════════════
let notesActiveTab = 'active';  // 'active' or 'done'

function switchNotesTab(tab) {
  notesActiveTab = tab;
  document.querySelectorAll('.notes-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`ntab-${tab}`).classList.add('active');
  renderNotes();
}

function renderNotes() {
  const list  = document.getElementById('notesList');
  const badge = document.getElementById('notesBadge');

  const activeNotes = notes.filter(n => !n.done);
  const doneNotes   = notes.filter(n => n.done);

  // Badge shows only active notes
  badge.textContent = activeNotes.length;

  // Update tab counts
  document.getElementById('ntab-active-count').textContent = activeNotes.length;
  document.getElementById('ntab-done-count').textContent   = doneNotes.length;

  const showing = notesActiveTab === 'active' ? activeNotes : doneNotes;

  if (!showing.length) {
    if (notesActiveTab === 'active') {
      list.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text3);font-size:.85rem">No notes yet.<br>Click "+ New Note" to add one!</div>`;
    } else {
      list.innerHTML = `<div class="notes-done-empty"><div class="done-empty-icon">✅</div>No completed notes yet.<br>Check off a note to move it here.</div>`;
    }
    return;
  }

  list.innerHTML = showing.map(n => `
    <div class="note-card ${n.done ? 'is-done' : ''}" style="background:${n.color}" onclick="openEditNoteModal('${n.id}')">
      <button class="note-card-del" onclick="event.stopPropagation(); confirmDelete('note','${n.id}')">✕</button>
      <div class="note-card-title">${esc(n.title)}</div>
      <div class="note-card-preview">${esc(n.content)}</div>
      <div class="note-card-meta">${formatDate(n.updated_at)}</div>
      <div class="note-card-check ${n.done ? 'checked' : ''}"
           onclick="event.stopPropagation(); toggleNoteDone('${n.id}')"
           title="${n.done ? 'Mark as active' : 'Mark as done'}">${n.done ? '✓' : ''}</div>
    </div>`).join('');
}
function openAddNoteModal() {
  ctx = { mode: 'add' };
  document.getElementById('noteModalTitle').textContent = 'New Note';
  document.getElementById('noteTitleInput').value   = '';
  document.getElementById('noteContentInput').value = '';
  selectColor('noteColorPicker', NOTE_COLORS[0]);
  openModal('noteModal');
  setTimeout(() => document.getElementById('noteTitleInput').focus(), 100);
}
function openEditNoteModal(id) {
  const n = notes.find(x => x.id === id);
  if (!n) return;
  ctx = { mode: 'edit', id };
  document.getElementById('noteModalTitle').textContent = 'Edit Note';
  document.getElementById('noteTitleInput').value   = n.title;
  document.getElementById('noteContentInput').value = n.content;
  selectColor('noteColorPicker', n.color);
  openModal('noteModal');
}
async function saveNote() {
  const title   = document.getElementById('noteTitleInput').value.trim() || 'Untitled';
  const content = document.getElementById('noteContentInput').value.trim();
  const color   = getSelectedColor('noteColorPicker') || NOTE_COLORS[0];

  closeModal('noteModal'); // close immediately — feels instant

  if (ctx.mode === 'add') {
    // → delegate to addNote() which handles optimistic UI
    addNote(title, content, color);

  } else {
    // ── OPTIMISTIC EDIT ──────────────────────────────────────
    const idx  = notes.findIndex(x => x.id === ctx.id);
    const prev = idx !== -1 ? { ...notes[idx] } : null;

    // 1. Update local state + re-render immediately
    if (idx !== -1) notes[idx] = { ...notes[idx], title, content, color, updated_at: new Date().toISOString() };
    renderNotes();
    showToast('Note updated! ✅');

    // 2. Sync to server in background
    try {
      const r = await fetch(`${apiBase()}/notes/${ctx.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, color })
      });
      if (!r.ok) throw new Error('Server error');
    } catch(e) {
      // 3. Rollback — restore previous note
      if (prev && idx !== -1) notes[idx] = prev;
      renderNotes();
      showToast('❌ Failed to update note. Changes reverted.');
    }
  }
}

async function addNote(title, content, color) {
  // ── OPTIMISTIC ADD ────────────────────────────────────────────
  // 1. Generate temp ID + build temp note object
  const tempId   = 'temp_' + Date.now();
  const tempNote = {
    id:         tempId,
    title,
    content,
    color,
    done:       false,
    updated_at: new Date().toISOString()
  };

  // 2. Add to local state + render immediately — user sees it NOW
  notes.unshift(tempNote);
  renderNotes();
  showToast('Note saved! ✅');

  // 3. Send to server in background
  try {
    const r = await fetch(`${apiBase()}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content, color })
    });
    if (!r.ok) throw new Error('Server error');
    const real = await r.json();

    // 4. Silently promote temp → real ID in state
    const idx = notes.findIndex(x => x.id === tempId);
    if (idx !== -1) notes[idx] = real;

    // 5. Swap tempId → real.id in any rendered onclick attributes
    document.querySelectorAll(`[onclick*="${tempId}"]`).forEach(el => {
      el.setAttribute('onclick', el.getAttribute('onclick').replaceAll(tempId, real.id));
    });

  } catch(e) {
    // 6. Rollback — remove temp note + re-render
    notes = notes.filter(x => x.id !== tempId);
    renderNotes();
    showToast('❌ Failed to save note. Please try again.');
  }
}

async function toggleNoteDone(noteId) {
  const n = notes.find(x => x.id === noteId);
  if (!n) return;
  n.done = !n.done;

  // Optimistic UI — re-render immediately
  renderNotes();

  // If we just marked done and we're on active tab, switch to done after a beat
  if (n.done && notesActiveTab === 'active') {
    showToast('Note moved to Done ✅');
  } else if (!n.done && notesActiveTab === 'done') {
    showToast('Note restored to Active 📝');
  }

  // API in background
  fetch(`${apiBase()}/notes/${noteId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ done: n.done })
  });
}

// ══════════════════════════════════════════════════════════════
//  DELETE
// ══════════════════════════════════════════════════════════════
function confirmDelete(type, ...ids) {
  const msgs = { subject: 'Delete this subject and ALL its content?', subsection: 'Delete this sub-subject and all its topics?', topic: 'Delete this topic?', note: 'Delete this note?' };
  document.getElementById('confirmMessage').textContent = msgs[type];
  document.getElementById('confirmDeleteBtn').onclick = () => executeDelete(type, ...ids);
  openModal('confirmModal');
}
async function executeDelete(type, ...ids) {
  closeModal('confirmModal');

  if (type === 'subject') {
    // ── OPTIMISTIC DELETE subject ───────────────────────────────
    const prev = subjects.find(x => x.id === ids[0]);
    const prevIdx = subjects.findIndex(x => x.id === ids[0]);
    const cardEl = document.getElementById(`subject-${ids[0]}`);
    const chipEl = document.getElementById(`chip-${ids[0]}`);

    // Remove from state + DOM immediately
    subjects = subjects.filter(x => x.id !== ids[0]);
    cardEl?.remove();
    chipEl?.remove();
    if (!subjects.length) {
      const g = document.getElementById('subjectsGrid');
      const e = document.getElementById('emptyState');
      if (g && e) { if (!g.contains(e)) g.appendChild(e); e.style.display = 'block'; }
    }
    refreshOverallProgress();
    showToast('Subject deleted');

    // Sync in background
    try {
      const r = await fetch(`${apiBase()}/subjects/${ids[0]}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Server error');
    } catch(e) {
      // Rollback — re-insert subject
      if (prev) {
        subjects.splice(prevIdx, 0, prev);
        const g = document.getElementById('subjectsGrid');
        const emptyEl = document.getElementById('emptyState');
        if (emptyEl) emptyEl.style.display = 'none';
        const newCard = buildSubjectCard(prev);
        // Try to insert at original position
        const cards = g.querySelectorAll('.subject-card');
        if (cards[prevIdx]) { g.insertBefore(newCard, cards[prevIdx]); }
        else { g.appendChild(newCard); }
        _addChipToStrip(prev);
        refreshOverallProgress();
        showToast('❌ Failed to delete subject. Restored.');
      }
    }

  } else if (type === 'subsection') {
    const [sid, ssid] = ids;
    const s = subjects.find(x => x.id === sid);
    const prevSS = s?.subsections.find(x => x.id === ssid);
    const prevSSIdx = s?.subsections.findIndex(x => x.id === ssid);
    const ssEl = document.getElementById(`ss-${ssid}`);

    // Remove immediately
    if (s) s.subsections = s.subsections.filter(x => x.id !== ssid);
    ssEl?.remove();
    refreshCardProgress(sid);
    showToast('Sub-subject deleted');

    try {
      const r = await fetch(`${apiBase()}/subjects/${sid}/subsections/${ssid}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Server error');
    } catch(e) {
      // Rollback
      if (s && prevSS) {
        s.subsections.splice(prevSSIdx, 0, prevSS);
        const list = document.getElementById(`ss-list-${sid}`);
        if (list) list.insertAdjacentHTML('beforeend', buildSubsectionHTML(sid, prevSS));
        refreshCardProgress(sid);
        showToast('❌ Failed to delete. Restored.');
      }
    }

  } else if (type === 'topic') {
    const [sid, ssid, tid] = ids;
    const s = subjects.find(x => x.id === sid);
    const ss = s?.subsections.find(x => x.id === ssid);
    const prevT = ss?.topics.find(x => x.id === tid);
    const prevTIdx = ss?.topics.findIndex(x => x.id === tid);
    const topicEl = document.getElementById(`t-${tid}`);

    // Remove immediately
    if (ss) ss.topics = ss.topics.filter(x => x.id !== tid);
    topicEl?.remove();
    if (ss) {
      const pe = document.getElementById(`ss-pct-${ssid}`);
      const d = ss.topics.filter(t => t.done).length;
      if (pe) pe.textContent = (ss.topics.length ? Math.round((d / ss.topics.length) * 100) : 0) + '%';
    }
    refreshCardProgress(sid);
    showToast('Topic deleted');

    try {
      const r = await fetch(`${apiBase()}/subjects/${sid}/subsections/${ssid}/topics/${tid}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Server error');
    } catch(e) {
      // Rollback
      if (ss && prevT) {
        ss.topics.splice(prevTIdx, 0, prevT);
        const list = document.getElementById(`topic-list-${ssid}`);
        if (list) list.insertAdjacentHTML('beforeend', buildTopicHTML(sid, ssid, prevT));
        refreshCardProgress(sid);
        showToast('❌ Failed to delete. Restored.');
      }
    }

  } else if (type === 'note') {
    const prevNote = notes.find(x => x.id === ids[0]);
    const prevNoteIdx = notes.findIndex(x => x.id === ids[0]);

    // Remove immediately
    notes = notes.filter(x => x.id !== ids[0]);
    renderNotes();
    showToast('Note deleted');

    try {
      const r = await fetch(`${apiBase()}/notes/${ids[0]}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Server error');
    } catch(e) {
      // Rollback
      if (prevNote) {
        notes.splice(prevNoteIdx, 0, prevNote);
        renderNotes();
        showToast('❌ Failed to delete. Restored.');
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════════════════
function toggleSubsection(ssId) {
  const body   = document.getElementById(`ssb-${ssId}`);
  const toggle = document.getElementById(`sst-${ssId}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);
}
function toggleNotesSidebar() {
  document.getElementById('notesSidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
}
function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('open'); el.style.display = 'flex'; }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('open'); el.style.display = 'none'; }
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-PH', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

// ── Color Pickers ──────────────────────────────────────────────
function buildColorPickers() {
  buildPicker('subjectColorPicker', SUBJECT_COLORS, SUBJECT_COLORS[0]);
  buildPicker('noteColorPicker',    NOTE_COLORS,    NOTE_COLORS[0]);
}
function buildPicker(containerId, colors, defaultColor) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  colors.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (c === defaultColor ? ' selected' : '');
    sw.style.background = c; sw.dataset.color = c;
    sw.onclick = () => selectColor(containerId, c);
    el.appendChild(sw);
  });
}
function selectColor(containerId, color) {
  document.querySelectorAll(`#${containerId} .color-swatch`)
    .forEach(sw => sw.classList.toggle('selected', sw.dataset.color === color));
}
function getSelectedColor(containerId) {
  const sw = document.querySelector(`#${containerId} .color-swatch.selected`);
  return sw ? sw.dataset.color : null;
}

// ── Keyboard shortcuts ──────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['subjectModal','noteModal','profileModal','confirmModal'].forEach(closeModal);
    if (document.getElementById('notesSidebar')?.classList.contains('open')) toggleNotesSidebar();
  }
});
document.querySelectorAll('.modal-backdrop').forEach(b => {
  b.addEventListener('click', e => { if (e.target === b) b.classList.remove('open'); });
});

// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  DAILY MOTIVATION — profession-aware local pool + Gemini optional
// ══════════════════════════════════════════════════════════════

const STUDY_TIPS = [
  "Use the Pomodoro technique — 25 min focused, then 5 min break.",
  "Teach what you just learned to an imaginary student. If you can explain it, you know it.",
  "Review notes within 24 hours to move info into long-term memory.",
  "Practice active recall — close your notes and write what you remember.",
  "Start with the hardest subject when your mind is freshest.",
  "Sleep consolidates memories. Never sacrifice sleep for cramming.",
  "Use mnemonics and acronyms for lists and sequences.",
  "Take practice exams under real conditions — timed, no distractions.",
  "Hydrate! Dehydration reduces focus and memory.",
  "Break big subjects into small chunks. One subsection at a time.",
  "Exercise before studying — it boosts memory and focus.",
  "Write by hand when memorizing. The physical act encodes information.",
  "Eliminate your phone during sessions. Every notification breaks flow.",
  "Celebrate small wins. Finished a subsection? That deserves pride.",
  "Group related topics together. Your brain loves patterns.",
];

const MOTIVATION_POOL = {
  nursing: [
    "Every vital sign you memorize and every drug calculation you master builds the nurse you are becoming, {name}. Your patients are waiting. Kaya mo!",
    "The NLE is just the gate you pass through to reach the people who need your care. Study hard today, {name}, and that gate will open.",
    "The nurses who pass their boards are those who kept going even when it was hard. Today is your chance to keep going, {name}. Let's get to work.",
    "From nursing process to pharmacology, each subject builds the complete nurse you are becoming. Trust the process, {name}. Ang tagumpay ay malapit na.",
    "Your future patients will never know how many nights you reviewed — but it will show in how you care for them. Keep going, {name}!",
    "SBAR, ABCs, Maslow's hierarchy — these tools will guide your clinical judgment for the rest of your career. Learn them well, {name}. Ikaw ang susunod na RN!",
    "Every chapter feels impossible until it clicks. Trust that understanding is coming, {name}. The exam is not the end — it is the beginning of your calling.",
    "Nurses save lives quietly, without capes. Your boards are your ticket to join that army of healers. Review today like someone's life depends on it, {name}.",
    "From maternity to community health, you are covering every corner of human care. That breadth will make you exceptional, {name}. Keep reviewing!",
    "Nursing is the art of caring and the science of healing. Every hour you review builds both. You are building a foundation that will hold lives, {name}.",
  ],
  electronics_engineering: [
    "From circuits to systems, every equation you master today builds the ECE engineer you are becoming. The board exam is yours to take, {name}!",
    "Electronics engineering is how the modern world runs. Every concept you review puts you closer to shaping that world professionally. Diskarte mo na, {name}!",
    "Every hour of review is an investment in the engineer you are becoming. The board exam is just the measurement — you are already building, {name}.",
    "From Ohm's Law to Fourier transforms — you have come so far. The finish line is closer than you think, {name}. Malakas ang loob mo!",
    "Signal processing, control systems, electronics design — each domain you master adds to your value as a future engineer. Review with purpose, {name}.",
    "Every great technology was built by someone who passed their boards and showed up every day. You are on that path, {name}. Kaya mo 'yan!",
    "The ECE board tests not just what you know — but how well you apply it under pressure. Review smart and consistently, {name}. Ikaw na 'yan!",
    "From transistors to telecommunications, your mastery builds every day. The board exam is just a snapshot — and your knowledge is growing, {name}.",
    "Mathematics, electronics, communication systems — three pillars of ECE mastery. Each one you strengthen today makes the next easier, {name}.",
    "The engineer who passes is not the smartest — it is the one who prepared most consistently. Your consistency is your greatest advantage, {name}.",
  ],
  civil_engineering: [
    "Every structure in the Philippines was designed by engineers like the one you are becoming. The boards are your gateway to building tomorrow, {name}.",
    "Structural analysis, hydraulics, geotechnics — each is a pillar of the civil engineer you are becoming. Master them one by one, {name}.",
    "Civil engineers build roads, bridges, and buildings where lives are lived. That future starts with today's review, {name}. Kaya mo!",
    "Every calculation you practice prepares you for the real decisions you will make as a civil engineer tomorrow, {name}.",
    "From surveying to structural design — you are learning to build a better Philippines. The board exam is the first step, {name}. Review with purpose!",
    "Every practice problem is a foundation block. Every formula memorized is a beam. You are constructing your expertise, {name}.",
    "Great civil engineers are made in the library before they prove themselves in the field. You are in the making phase, {name}.",
    "From soil mechanics to steel design — the boards test your readiness to protect public safety. Review well, {name}. Ang Pilipinas ay nangangailangan ng mga tulad mo.",
    "The best structural engineers understand why things fail — so they build things that hold. Study with that analytical mindset today, {name}.",
    "Concrete starts as simple ingredients mixed together. Your engineering knowledge is the same — built from individual concepts mastered one by one, {name}.",
  ],
  engineering: [
    "Mathematics is the language of engineering. Every hour mastering it makes you a stronger engineer. Keep studying, {name} — your future is being built right now.",
    "Engineering is problem-solving at its finest. Every equation you review is another tool in your toolkit. Use them well, {name}. Kaya mo!",
    "From calculus to engineering sciences — you are developing the complete mind of a licensed engineer. One topic at a time, {name}.",
    "Your board exam is your license to shape the physical world professionally. Every study session brings you closer, {name}. Magsumikap!",
    "The best engineers were once board reviewers just like you — exhausted, pushing through. They passed because they did not quit. You will not quit either, {name}.",
    "Engineering mastery is understanding so deep that you can apply concepts in any form the exam presents. Study for understanding, {name}. Diskarte mo na!",
    "Every great structure was once marks on paper. Every great engineer was once a student reviewing for boards. You are at that beginning, {name}.",
    "The engineering profession demands excellence because it protects lives. Your dedication to reviewing is already a sign you belong here, {name}.",
    "One formula understood is worth ten memorized. Go deep today, {name} — understanding serves you in the exam room and in the field.",
    "Review like you are building a bridge — one component at a time, checking each connection. That approach will carry you through the boards, {name}.",
  ],
  cpa: [
    "Auditing, taxation, financial accounting — each builds the complete accountant you are becoming. The CPA board is your license to be trusted with what matters most, {name}.",
    "Numbers tell stories and CPAs read them with precision. Every accounting standard you master brings you closer to reading those stories professionally, {name}.",
    "The CPA board is one of the most rigorous exams in the Philippines — its difficulty is a measure of the trust society places in accountants. You are earning that trust, {name}.",
    "The best accountants understand not just the rules — but the principles behind them. Review for understanding, {name}, and the boards will feel like a conversation.",
    "Every journal entry and tax computation you practice today makes you sharper. Sharper accountants serve clients better. Keep sharpening, {name}.",
    "CPA means trusted financial guardian. Your boards certify that trust. Earn it today through your review, {name}. Malakas ang loob mo!",
    "The accounting profession is built on integrity and competence. Your board preparation demonstrates both every single day, {name}.",
    "From debits and credits to complex financial instruments — you have mastered concepts most people never understand. The board will recognize that mastery, {name}.",
    "Behind every business decision is a CPA's analysis. Your preparation is building the analytical mind that businesses will rely on, {name}.",
    "Taxation, auditing, financial reporting — three mountains you are climbing. Each summit makes you more complete as a professional, {name}. Kaya mo!",
  ],
  teaching: [
    "The best teachers are always students first. Your LET preparation proves you are already the kind of learner you will inspire your students to be, {name}.",
    "Teaching is the profession that creates all other professions. The LET is your license to shape minds and inspire futures. Study with that purpose, {name}.",
    "From child development to professional education — every topic makes you a more complete teacher. The LET is just the beginning of a lifetime of learning, {name}.",
    "Piaget, Vygotsky, Bloom — these are not just exam names. They are guides that will shape your teaching every single day. Learn them deeply, {name}.",
    "Every child who struggles is waiting for a teacher who understands learning deeply enough to meet them where they are. The LET is your ticket, {name}.",
    "Great teachers are knowledgeable and empathetic. Your LET preparation builds the knowledge — your heart provides the empathy. You already have both, {name}.",
    "Teaching in the Philippines is both a challenge and an honor. The LET certifies you are prepared for both. Study hard, {name}.",
    "From curriculum design to classroom management — you are becoming the complete educator. The LET will recognize your preparation, {name}. Ikaw ang pag-asa ng kabataan!",
    "The teacher who changed your life once passed a board exam too. Now it is your turn to become that person for someone else, {name}.",
    "Teachers do not just deliver lessons — they create futures. Every study hour is an investment in students who will one day thank you, {name}. Kaya mo!",
  ],
  general: [
    "Every licensed professional once sat where you are — reviewing, pushing through, choosing not to quit. They passed. You will too, {name}. Kaya mo!",
    "The board exam tests not just what you know — it tests your character. Showing up to study today is already passing that test, {name}.",
    "Your board exam is the last gate between where you are and the licensed professional you are becoming. Every session is one step closer, {name}.",
    "Ang tagumpay ay hindi para sa pinakamatalino — ito ay para sa pinaka-determinado. You are showing that determination every time you open your books, {name}.",
    "One year from now, you will be a licensed professional. The foundation of that future is being built right now, in these study sessions. Build it strong, {name}.",
    "Professionals are not born — they are made through study, practice, failure, and persistence. You are in the making right now, {name}.",
    "The Philippines needs more licensed professionals committed to serving their communities. You are becoming one of them, {name}.",
    "Hindi madali ang landas ng isang propesyonal — but nothing worthwhile ever is. Show up for yourself today. One topic at a time, {name}.",
    "Your board exam preparation is the most important investment you are making right now. Every hour compounds. Every concept mastered adds to your readiness, {name}.",
    "The person who passes is not the one who never doubted — it is the one who studied anyway. Study anyway today, {name}. Ikaw 'yan!",
  ],
};

function detectProfession(subjectList) {
  const text = subjectList.map(function(s) { return s.name; }).join(' ').toLowerCase();
  if (/nurs|nclex|surgical|maternal|pediatr|obstet|psychiatric|community health/i.test(text)) return 'nursing';
  if (/electron|circuit|signal|telecommun|microelectron|semiconductor/i.test(text)) return 'electronics_engineering';
  if (/civil|structural|hydraulic|geotechn|surveying|strength of materials/i.test(text)) return 'civil_engineering';
  if (/mechanic|thermodynam|fluid|machine design/i.test(text)) return 'mechanical_engineering';
  if (/accountan|audit|taxation|financial accounting|cpa/i.test(text)) return 'cpa';
  if (/architect|building|planning|history of arch/i.test(text)) return 'architecture';
  if (/law|criminal|civil law|constitutional|bar exam/i.test(text)) return 'law';
  if (/medicine|anatomy|biochem|patholog|microbio|internal medicine/i.test(text)) return 'medicine';
  if (/teacher|education|lept|professional education|child development/i.test(text)) return 'teaching';
  if (/criminolog|crime|forensic/i.test(text)) return 'criminology';
  if (/pharmacy|pharmacog|pharmaceutical/i.test(text)) return 'pharmacy';
  if (/mathematics|calculus|algebra|engineering sciences|applied sciences/i.test(text)) return 'engineering';
  return 'general';
}

function getTodayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate();
}

async function fetchMotivation() {
  const loading = document.getElementById('motivationLoading');
  const msgEl   = document.getElementById('motivationMessage');
  const footer  = document.getElementById('motivationFooter');
  const dateEl  = document.getElementById('motivationDate');
  const tipEl   = document.getElementById('motivationTip');
  const tipText = document.getElementById('motivationTipText');
  if (!msgEl) return;

  const todayKey = getTodayKey();
  const name     = currentUser ? currentUser.display_name : 'reviewer';
  const profKey  = detectProfession(subjects);
  const uid      = currentUser ? currentUser.id : 'anon';
  const cacheKey  = 'bprep_motiv_' + uid + '_' + todayKey;

  // Same day — serve from cache (do NOT call Gemini again)
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached && cached.message && cached.date === todayKey) {
        renderMotivation(cached.message, cached.tip, todayKey);
        return;  // ← locked in for the day, no API call
      }
    }
  } catch(e) {}

  if (loading) loading.style.display = 'block';
  if (msgEl)   msgEl.style.display   = 'none';
  if (footer)  footer.style.display  = 'none';
  if (tipEl)   tipEl.style.display   = 'none';

  let message = null;

  // Call backend motivation route — key stays secure on server
  if (currentUser) {
    try {
      const subNames = subjects.map(function(s) { return s.name; }).slice(0, 5).join(', ') || 'board exam subjects';
      const pData = subjects.reduce(function(a, s) {
        const p = subjectProgress(s);
        return { t: a.t + p.total, d: a.d + p.done };
      }, { t: 0, d: 0 });
      const pct = pData.t === 0 ? 0 : Math.round((pData.d / pData.t) * 100);

      const resp = await fetch(`/api/profiles/${currentUser.id}/daily-motivation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, subjects: subNames, pct })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.message) message = data.message;
      }
    } catch(e) { /* silent — fall through to local pool */ }
  }

  // Local pool fallback — always works, no API needed
  if (!message) {
    const pool = MOTIVATION_POOL[profKey] || MOTIVATION_POOL['general'];
    const dayOfYear = Math.floor(Date.now() / 86400000);
    message = pool[dayOfYear % pool.length].replace(/{name}/g, name);
  }

  const dayOfYear = Math.floor(Date.now() / 86400000);
  const tip = STUDY_TIPS[dayOfYear % STUDY_TIPS.length];

  try { localStorage.setItem(cacheKey, JSON.stringify({ message: message, tip: tip, date: todayKey })); } catch(e) {}

  renderMotivation(message, tip, todayKey);
}

function renderMotivation(message, tip, dateKey) {
  const loading = document.getElementById('motivationLoading');
  const msgEl   = document.getElementById('motivationMessage');
  const footer  = document.getElementById('motivationFooter');
  const dateEl  = document.getElementById('motivationDate');
  const tipEl   = document.getElementById('motivationTip');
  const tipText = document.getElementById('motivationTipText');
  if (!msgEl) return;

  if (loading) loading.style.display = 'none';
  msgEl.innerHTML = message.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  msgEl.style.display = 'block';

  if (footer) footer.style.display = 'flex';
  if (dateEl) {
    try {
      const parts = dateKey.split('-');
      const date  = new Date(parts[0], parts[1]-1, parts[2]);
      dateEl.textContent = date.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch(e) {}
  }
  if (tip && tipText) {
    tipText.textContent = tip;
    if (tipEl) tipEl.style.display = 'block';
  }
}

// ══════════════════════════════════════════════════════════════
//  POMODORO TIMER
// ══════════════════════════════════════════════════════════════

const POM_MODES = {
  focus: { label: 'Stay focused for 25 minutes!', secs: 25 * 60, color: 'var(--green)' },
  short: { label: 'Short break — breathe!',        secs:  5 * 60, color: '#60a5fa'      },
  long:  { label: 'Long break — you earned it!',   secs: 15 * 60, color: '#a78bfa'      }
};
const CIRCUMFERENCE = 2 * Math.PI * 52; // matches r="52" in SVG

let pomMode    = 'focus';
let pomSeconds = POM_MODES.focus.secs;
let pomTotal   = POM_MODES.focus.secs;
let pomRunning = false;
let pomTimer   = null;
let pomSession = 1;  // 1–4 focus sessions then long break

function showPomodoroFab() {
  const fab = document.getElementById('pomodoroFab');
  if (fab) fab.style.display = 'flex';
}

function togglePomodoro() {
  const widget = document.getElementById('pomodoroWidget');
  const fab    = document.getElementById('pomodoroFab');
  if (!widget) return;
  const isOpen = widget.style.display !== 'none';
  widget.style.display = isOpen ? 'none' : 'block';
}

function switchMode(mode) {
  pomMode    = mode;
  pomSeconds = POM_MODES[mode].secs;
  pomTotal   = POM_MODES[mode].secs;
  pomRunning = false;
  clearInterval(pomTimer);

  // Update tab styles
  ['focus','short','long'].forEach(m => {
    const tab = document.getElementById(`tab-${m}`);
    if (tab) tab.classList.toggle('active', m === mode);
  });

  // Update ring color
  const ring = document.getElementById('pomRingProgress');
  if (ring) {
    ring.style.stroke = POM_MODES[mode].color;
    ring.classList.toggle('break-mode', mode !== 'focus');
  }

  // Update play button color
  const play = document.getElementById('pomPlayBtn');
  if (play) play.classList.toggle('break-mode', mode !== 'focus');

  // Update footer label
  const footer = document.getElementById('pomModeLabel');
  if (footer) footer.textContent = POM_MODES[mode].label;

  // Update display
  renderPomTimer();
  const playBtn = document.getElementById('pomPlayBtn');
  if (playBtn) playBtn.textContent = '▶';
}

function togglePomodoro_timer() {
  if (pomRunning) {
    pausePomodoro();
  } else {
    startPomodoro();
  }
}

function startPomodoro() {
  pomRunning = true;
  const playBtn = document.getElementById('pomPlayBtn');
  if (playBtn) playBtn.textContent = '⏸';

  const fab = document.getElementById('pomodoroFab');
  if (fab) {
    fab.classList.toggle('running',       pomMode === 'focus');
    fab.classList.toggle('break-running', pomMode !== 'focus');
  }

  pomTimer = setInterval(() => {
    pomSeconds--;
    renderPomTimer();
    if (pomSeconds <= 0) {
      clearInterval(pomTimer);
      pomRunning = false;
      onPomodoroComplete();
    }
  }, 1000);
}

function pausePomodoro() {
  pomRunning = false;
  clearInterval(pomTimer);
  const playBtn = document.getElementById('pomPlayBtn');
  if (playBtn) playBtn.textContent = '▶';
  const fab = document.getElementById('pomodoroFab');
  if (fab) { fab.classList.remove('running'); fab.classList.remove('break-running'); }
}

function resetPomodoro() {
  pausePomodoro();
  pomSeconds = POM_MODES[pomMode].secs;
  pomTotal   = POM_MODES[pomMode].secs;
  renderPomTimer();
}

function skipPomodoro() {
  pausePomodoro();
  onPomodoroComplete();
}

function playPomSound(mode) {
  try {
    const actx = new (window.AudioContext || window.webkitAudioContext)();

    if (mode === 'focus') {
      // Focus session done → warm ascending chime: "Great work, take a break!"
      // 3 rising tones, each 0.5s long with slow fade
      const notes = [523, 659, 784]; // C5 → E5 → G5 (major chord, uplifting)
      notes.forEach((freq, i) => {
        const osc  = actx.createOscillator();
        const gain = actx.createGain();
        osc.connect(gain);
        gain.connect(actx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = actx.currentTime + i * 0.55;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.45, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        osc.start(t);
        osc.stop(t + 0.5);
      });

    } else {
      // Break done → gentle low-to-high double ping: "Back to work!"
      // 2 soft pings, lower pitch, shorter
      const notes = [440, 554]; // A4 → C#5 (gentle nudge)
      notes.forEach((freq, i) => {
        const osc  = actx.createOscillator();
        const gain = actx.createGain();
        osc.connect(gain);
        gain.connect(actx.destination);
        osc.type = 'triangle'; // softer tone than sine
        osc.frequency.value = freq;
        const t = actx.currentTime + i * 0.45;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.3, t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        osc.start(t);
        osc.stop(t + 0.4);
      });
    }

  } catch(e) {}
}

function onPomodoroComplete() {
  // Play sound — different tone for focus done vs break done
  playPomSound(pomMode);

  // Notify
  if (Notification.permission === 'granted') {
    new Notification('BoardPrep PH 🍅', {
      body: pomMode === 'focus' ? 'Break time! You earned it.' : 'Back to studying!',
      icon: '/static/favicon.svg'
    });
  }

  // Cycle: focus → short break → focus → ... → after 4 focuses → long break
  if (pomMode === 'focus') {
    pomSession = Math.min(pomSession + 1, 5);
    renderPomDots();
    if (pomSession > 4) {
      pomSession = 1;
      switchMode('long');
    } else {
      switchMode('short');
    }
  } else {
    switchMode('focus');
  }

  // Auto-start the next mode
  startPomodoro();
}

function renderPomTimer() {
  const m = Math.floor(pomSeconds / 60).toString().padStart(2, '0');
  const s = (pomSeconds % 60).toString().padStart(2, '0');
  const timeEl = document.getElementById('pomTime');
  if (timeEl) timeEl.textContent = `${m}:${s}`;

  // Ring progress
  const progress = pomSeconds / pomTotal;
  const offset   = CIRCUMFERENCE * (1 - progress);
  const ring = document.getElementById('pomRingProgress');
  if (ring) ring.style.strokeDashoffset = offset;

  // Update page title when running
  if (pomRunning) {
    document.title = `${m}:${s} — BoardPrep PH`;
  } else {
    document.title = 'BoardPrep PH';
  }
}

function renderPomDots() {
  const dotsEl  = document.getElementById('pomDots');
  const sessEl  = document.getElementById('pomSession');
  if (sessEl) sessEl.textContent = Math.min(pomSession, 4);
  if (!dotsEl) return;
  dotsEl.innerHTML = '';
  for (let i = 1; i <= 4; i++) {
    const dot = document.createElement('div');
    dot.className = 'pom-dot' + (i < pomSession ? ' done' : i === pomSession ? ' current' : '');
    dotsEl.appendChild(dot);
  }
}

// Request notification permission on first interaction
document.addEventListener('click', function reqNotif() {
  if (Notification.permission === 'default') Notification.requestPermission();
  document.removeEventListener('click', reqNotif);
}, { once: true });


// ══════════════════════════════════════════════════════════════
//  FLASHCARD SIDEBAR
// ══════════════════════════════════════════════════════════════

let flashcards           = {};  // { "subj_ID" or "ss_ID": [cards] }
let fcSidebarSubjectId   = null;
let fcSidebarSubjectName = '';
let fcSidebarSsId        = null;  // currently selected subsection (null = subject level)
let fcSidebarSsName      = '';

async function toggleFlashcardSidebar() {
  const sidebar  = document.getElementById('flashcardSidebar');
  const overlay  = document.getElementById('flashcardOverlay');
  const isOpen   = sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    // Load ALL counts first, then render so badges show correct numbers immediately
    await loadAllFlashcardCounts();
    sidebar.classList.add('open');
    overlay.classList.add('open');
    renderFlashcardSubjectList();
  }
}

// ══════════════════════════════════════════════════════════════
//  AI CHAT SIDEBAR
// ══════════════════════════════════════════════════════════════

let chatLoaded = false;

async function toggleChatSidebar() {
  const sidebar = document.getElementById('chatSidebar');
  const overlay = document.getElementById('chatOverlay');
  const isOpen  = sidebar.classList.contains('open');

  if (isOpen) {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    sidebar.classList.add('open');
    overlay.classList.add('open');
    setupChatUI();
    if (!chatLoaded) {
      await loadChatHistory();
      chatLoaded = true;
    }
    setTimeout(() => scrollChatToBottom(), 100);
  }
}

function setupChatUI() {
  const plan    = currentUser && currentUser.plan;
  const isPaid  = currentUser && currentUser.is_pro && plan !== 'trial';
  const body    = document.getElementById('chatBody');
  const upgrade = document.getElementById('chatUpgradeBox');
  if (!body || !upgrade) return;

  if (isPaid) {
    body.style.display    = 'flex';
    upgrade.style.display = 'none';
  } else {
    body.style.display    = 'none';
    upgrade.style.display = 'flex';
  }
}

async function loadChatHistory() {
  if (!currentUser) return;
  try {
    const r = await fetch(`${apiBase()}/chat-history`, { credentials: 'include' });
    if (!r.ok) return;
    const messages = await r.json();
    const container = document.getElementById('chatMessages');
    if (!container) return;

    // Clear welcome if we have history
    if (messages.length > 0) {
      container.innerHTML = '';
      messages.forEach(m => {
        // Skip raw JSON flashcard messages — show friendly message only
        if (m.role === 'assistant' && m.content.trim().startsWith('{') && m.content.includes('"flashcards"')) {
          return;
        }
        appendChatBubble(m.role, m.content, m.created_at, false);
      });
    }
    scrollChatToBottom();
  } catch(e) { console.error('Chat history load error:', e); }
}

async function sendChatMessage() {
  const input   = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSendBtn');
  const typing  = document.getElementById('chatTyping');
  const message = (input ? input.value || '' : '').trim();
  if (!message || !sendBtn || sendBtn.disabled) return;

  // Detect flashcard intent early for progressive UI
  const msgLower = message.toLowerCase();
  const flashcardIntent = ['flashcard','flash card','make me','create','generate',
    'gumawa','tanong','questions for','in english','in tagalog','ulit','redo'].some(kw => msgLower.includes(kw));

  // Clear welcome message on first send
  const container = document.getElementById('chatMessages');
  const welcome   = container.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  // Show user bubble
  appendChatBubble('user', message, null, true);
  input.value = '';
  input.style.height = 'auto';

  // Disable input, show typing
  sendBtn.disabled    = true;
  input.disabled      = true;
  if (typing) typing.style.display = 'block';
  requestAnimationFrame(() => scrollChatToBottom());

  // Show loading modal immediately if flashcard intent detected
  if (flashcardIntent) showFlashcardLoadingModal();

  try {
    const r = await fetch(`${apiBase()}/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    const data = await r.json();
    if (typing) typing.style.display = 'none';

    if (!r.ok) {
      if (data.error === 'pro_required') {
        setupChatUI();
      } else {
        appendChatBubble('ai', `⚠️ ${data.error || 'Something went wrong. Please try again.'}`, null, true);
      }
    } else if (data.flashcards) {
      // Show flashcard preview FIRST, then friendly message below
      appendFlashcardPreview(data.flashcards);
      appendChatBubble('ai', data.reply || data.flashcards.message, null, true);
      scrollChatToBottom();
    } else if (data.reply && data.reply.includes('"flashcards"')) {
      // Raw JSON from AI — parse and show preview first
      if (!tryRenderFlashcardReply(data.reply)) {
        closeChatFlashcardModal(); // close loading if parse failed
        appendChatBubble('ai', '⚠️ Could not render flashcards. Please try again.', null, true);
      }
    } else {
      closeChatFlashcardModal(); // close loading modal if not flashcards
      appendChatBubble('ai', data.reply, null, true);
    }
  } catch(e) {
    if (typing) typing.style.display = 'none';
    appendChatBubble('ai', '⚠️ Connection error. Please check your internet and try again.', null, true);
  } finally {
    sendBtn.disabled = false;
    input.disabled   = false;
    input.focus();
    scrollChatToBottom();
  }
}

function appendChatBubble(role, content, timestamp, animate) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  const wrap = document.createElement('div');
  wrap.className = `chat-bubble-wrap ${role === 'user' ? 'user' : 'ai'}`;

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role === 'user' ? 'user' : 'ai'}`;
  bubble.textContent = content;

  const time = document.createElement('div');
  time.className = 'chat-bubble-time';
  const d = timestamp ? new Date(timestamp) : new Date();
  time.textContent = d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });

  wrap.appendChild(bubble);
  wrap.appendChild(time);

  const typing = document.getElementById('chatTyping');
  const insertBefore = typing && typing.parentNode === container ? typing : null;

  if (animate) {
    wrap.style.opacity = '0';
    wrap.style.transform = 'translateY(8px)';
    wrap.style.transition = 'opacity 0.25s, transform 0.25s';
    insertBefore ? container.insertBefore(wrap, insertBefore) : container.appendChild(wrap);
    requestAnimationFrame(() => {
      wrap.style.opacity = '1';
      wrap.style.transform = 'translateY(0)';
    });
  } else {
    insertBefore ? container.insertBefore(wrap, insertBefore) : container.appendChild(wrap);
  }
}

function tryRenderFlashcardReply(text) {
  if (!text) return false;
  console.log('[Tsuki] tryRenderFlashcardReply called, text starts with:', text.substring(0, 50));
  if (!text.includes('"flashcards"')) {
    console.log('[Tsuki] No flashcards key found, skipping');
    return false;
  }
  try {
    // Strip markdown fences
    let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();

    // Fix ALL invalid JSON backslash sequences (LaTeX commands, special chars, etc.)
    // Mirrors the backend _fix_latex_json logic for consistency.
    clean = clean.replace(/\\(u[0-9a-fA-F]{4})|\\([a-zA-Z]+|[^"\\\s])/g, function(m, uni, seq) {
      if (uni !== undefined) return m;  // valid \uXXXX — keep
      if (seq.length === 1 && '"\\\/bfnrtu'.indexOf(seq) >= 0) return m;  // valid escape
      return '\\\\' + seq;  // double-escape everything else
    });

    // Find the outermost JSON object
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start === -1 || end === -1) { console.log('[Tsuki] No JSON object found'); return false; }
    const jsonStr = clean.slice(start, end + 1);
    console.log('[Tsuki] Attempting JSON.parse...');
    const parsed  = JSON.parse(jsonStr);
    console.log('[Tsuki] Parsed OK, cards:', parsed.flashcards?.length);
    if (!parsed.flashcards || !Array.isArray(parsed.flashcards)) return false;
    const cards = parsed.flashcards.filter(c => c.question && c.answer).slice(0, 10);
    if (!cards.length) return false;

    // Match subject/subsection to real IDs
    const subjectName = parsed.subject || '';
    const ssName      = parsed.subsection || null;
    let subjectId = null, ssId = null, subjectDisplay = subjectName, ssDisplay = ssName;

    for (const s of subjects) {
      if (s.name.toLowerCase() === subjectName.toLowerCase()) {
        subjectId      = s.id;
        subjectDisplay = s.name;
        if (ssName) {
          for (const ss of (s.subsections || [])) {
            if (ss.name.toLowerCase() === ssName.toLowerCase()) {
              ssId      = ss.id;
              ssDisplay = ss.name;
              break;
            }
          }
        }
        break;
      }
    }
    if (!subjectId && subjects.length) {
      subjectId      = subjects[0].id;
      subjectDisplay = subjects[0].name;
    }

    const fcData = {
      flashcards:      cards,
      subject:         subjectDisplay,
      subject_id:      subjectId,
      subject_name:    subjectDisplay,
      subsection:      ssDisplay,
      subsection_id:   ssId,
      subsection_name: ssDisplay,
      message:         parsed.message || `Here are ${cards.length} flashcards!`
    };

    appendFlashcardPreview(fcData);
    appendChatBubble('ai', fcData.message, null, true);
    scrollChatToBottom();
    return true;
  } catch(e) {
    console.error('[tryRenderFlashcardReply]', e);
    return false;
  }
}


function appendFlashcardPreview(fcData) {
  showChatFlashcardModal(fcData);
}

// Store current flashcard data for saving
let _currentChatFcData = null;

function renderMath(element) {
  if (typeof renderMathInElement !== 'function') return;
  try {
    renderMathInElement(element, {
      delimiters: [
        { left: '$$', right: '$$', display: true  },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true  }
      ],
      throwOnError: false,
      errorColor: 'var(--text2)',  // use normal text color for errors
      strict: false,
      trust: false
    });
    // Remove any red KaTeX error spans and replace with plain text
    element.querySelectorAll('.katex-error').forEach(err => {
      const plain = document.createTextNode(err.textContent);
      err.replaceWith(plain);
    });
  } catch(e) {}
}


function showFlashcardLoadingModal() {
  const modal = document.getElementById('chatFlashcardModal');
  document.getElementById('chatFcModalTitle').textContent = '✨ Generating Flashcards...';
  const list = document.getElementById('chatFcModalList');
  list.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3rem 2rem;gap:16px;">
      <div class="fc-gen-spinner"></div>
      <div style="font-size:0.9rem;color:var(--text2);text-align:center;">
        Tsuki is crafting your flashcards...<br/>
        <span style="font-size:0.8rem;color:var(--text3);">This may take a few seconds</span>
      </div>
    </div>`;
  const saveBtn = document.getElementById('chatFcSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Generating...'; }
  modal.style.display = 'flex';
}

function showChatFlashcardModal(fcData) {
  _currentChatFcData = fcData;
  const cards   = fcData.flashcards || [];
  const subName = fcData.subsection_name || fcData.subject_name || 'your subject';

  // Animate title update
  const title = document.getElementById('chatFcModalTitle');
  title.textContent = `🎴 ${cards.length} Flashcards — ${subName}`;

  // Build list with stagger animation
  const list = document.getElementById('chatFcModalList');
  list.innerHTML = '';
  cards.forEach((c, i) => {
    const item = document.createElement('div');
    item.style.cssText = `padding:12px 20px;border-bottom:1px solid var(--border);
      opacity:0;transform:translateY(8px);transition:opacity 0.2s ${i*40}ms, transform 0.2s ${i*40}ms;`;
    const q = document.createElement('div');
    q.style.cssText = 'font-size:0.88rem;font-weight:600;color:var(--text);margin-bottom:5px;line-height:1.4;';
    q.textContent = `${i+1}. ${c.question}`;
    renderMath(q);
    const a = document.createElement('div');
    a.style.cssText = 'font-size:0.82rem;color:var(--text2);border-left:3px solid var(--gold);padding-left:10px;line-height:1.5;';
    a.textContent = c.answer;
    renderMath(a);
    item.appendChild(q);
    item.appendChild(a);
    list.appendChild(item);
    // Trigger animation
    requestAnimationFrame(() => requestAnimationFrame(() => {
      item.style.opacity = '1';
      item.style.transform = 'translateY(0)';
    }));
  });

  // Reset save button
  const saveBtn = document.getElementById('chatFcSaveBtn');
  if (saveBtn) {
    saveBtn.textContent  = '💾 Save All to Flashcards';
    saveBtn.disabled     = false;
    saveBtn.style.background = '';
    saveBtn.style.color = '';
  }

  // Show modal (already visible if loading was shown)
  document.getElementById('chatFlashcardModal').style.display = 'flex';
}

function closeChatFlashcardModal() {
  document.getElementById('chatFlashcardModal').style.display = 'none';
  _currentChatFcData = null;
}

async function saveChatFlashcardsFromModal() {
  if (!_currentChatFcData || !currentUser) return;
  const { flashcards: cards, subject_id: subjectId, subsection_id: ssId } = _currentChatFcData;
  const btn = document.getElementById('chatFcSaveBtn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  let saved = 0;
  for (const card of cards) {
    try {
      const r = await fetch(`${apiBase()}/flashcards`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject_id:    subjectId,
          subsection_id: ssId || null,
          question:      card.question,
          answer:        card.answer
        })
      });
      if (r.ok) saved++;
    } catch(e) {}
  }

  btn.textContent      = `✅ ${saved} saved!`;
  btn.style.background = 'var(--green)';
  btn.style.color      = '#fff';
  setTimeout(() => closeChatFlashcardModal(), 1500);

  // Refresh flashcard sidebar counts
  try { await loadAllFlashcardCounts(); renderFlashcardSubjectList(); } catch(e) {}
}

async function saveFlashcardsFromChat(cards, subjectId, subsectionId, btn) {
  if (!currentUser || !subjectId) return;
  btn.disabled     = true;
  btn.textContent  = 'Saving…';

  let saved = 0;
  for (const card of cards) {
    try {
      const r = await fetch(`${apiBase()}/flashcards`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject_id:    subjectId,
          subsection_id: subsectionId || null,
          question:      card.question,
          answer:        card.answer
        })
      });
      if (r.ok) saved++;
    } catch(e) { /* continue */ }
  }

  btn.textContent = `✅ ${saved} flashcard${saved !== 1 ? 's' : ''} saved!`;
  btn.style.background = 'var(--green)';
  btn.style.color      = '#fff';

  // Refresh flashcard counts if sidebar is open
  try { await loadAllFlashcardCounts(); renderFlashcardSubjectList(); } catch(e) {}
}

function scrollChatToBottom() {
  const c = document.getElementById('chatMessages');
  if (c) c.scrollTop = c.scrollHeight;
}

async function clearChatHistory() {
  if (!currentUser) return;
  if (!confirm('Clear all chat history? This cannot be undone.')) return;
  try {
    await fetch(`${apiBase()}/chat-history`, { method: 'DELETE', credentials: 'include' });
    const container = document.getElementById('chatMessages');
    if (container) {
      container.innerHTML = `
        <div class="chat-welcome">
          <div style="font-size:2rem">👋</div>
          <div style="font-weight:700;color:var(--text)">Hi! I'm Tsuki, your AI study buddy 🌙.</div>
          <div style="font-size:0.83rem;color:var(--text2);line-height:1.6">
            Ask me anything about your board exam subjects, request a quick review, or just tell me how studying is going!
          </div>
        </div>`;
    }
    chatLoaded = false;
  } catch(e) { alert('Failed to clear chat. Please try again.'); }
}

async function loadAllFlashcardCounts() {
  // Fetch all flashcards for this user in ONE request, then group by subject/subsection
  try {
    const r = await fetch(`${apiBase()}/flashcards`);
    if (!r.ok) return;
    const all = await r.json();

    // Reset counts
    subjects.forEach(s => {
      if (!flashcards[s.id]) flashcards[s.id] = [];
      s.subsections.forEach(ss => {
        if (!flashcards['ss_' + ss.id]) flashcards['ss_' + ss.id] = [];
      });
    });

    // Group by subject_id and subsection_id
    all.forEach(card => {
      if (card.subsection_id) {
        const key = 'ss_' + card.subsection_id;
        if (!flashcards[key]) flashcards[key] = [];
        // Avoid duplicates
        if (!flashcards[key].find(c => c.id === card.id)) {
          flashcards[key].push(card);
        }
      } else if (card.subject_id) {
        if (!flashcards[card.subject_id]) flashcards[card.subject_id] = [];
        if (!flashcards[card.subject_id].find(c => c.id === card.id)) {
          flashcards[card.subject_id].push(card);
        }
      }
    });
  } catch(e) {}
}

function renderFlashcardSubjectList() {
  const list = document.getElementById('fc-subject-list');
  if (!list) return;
  if (!subjects.length) {
    list.innerHTML = '<div class="fc-empty">No subjects yet. Add a subject first!</div>';
    return;
  }
  list.innerHTML = subjects.map(s => {
    const ssHTML = s.subsections.length ? s.subsections.map(ss => `
      <div class="fc-ss-item ${fcSidebarSsId === ss.id ? 'active' : ''}"
           id="fc-ss-${ss.id}"
           onclick="selectFlashcardSS('${s.id}','${esc(s.name)}','${s.color}','${ss.id}','${esc(ss.name)}')">
        <span class="fc-ss-dash">—</span>
        <span class="fc-subject-name">${esc(ss.name)}</span>
        <span class="fc-subject-count" id="fc-count-ss-${ss.id}">
          ${(flashcards['ss_' + ss.id] || []).length}
        </span>
      </div>`).join('') : '';

    return `
    <div class="fc-subject-item ${fcSidebarSubjectId === s.id && !fcSidebarSsId ? 'active' : ''}"
         id="fc-subj-${s.id}"
         onclick="selectFlashcardSubject('${s.id}','${esc(s.name)}','${s.color}')">
      <div class="fc-subject-dot" style="background:${s.color}"></div>
      <span class="fc-subject-name">${esc(s.name)}</span>
      <span class="fc-subject-count" id="fc-count-${s.id}">
        ${(flashcards[s.id] || []).length + s.subsections.reduce((sum, ss) => sum + (flashcards['ss_' + ss.id] || []).length, 0)}
      </span>
    </div>
    ${ssHTML}`;
  }).join('');
}

async function selectFlashcardSubject(subjectId, subjectName, color) {
  fcSidebarSubjectId   = subjectId;
  fcSidebarSubjectName = subjectName;
  fcSidebarSsId        = null;
  fcSidebarSsName      = '';

  // Update active states
  document.querySelectorAll('.fc-subject-item, .fc-ss-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById(`fc-subj-${subjectId}`);
  if (item) item.classList.add('active');

  // Show panel
  document.getElementById('fc-subject-panel').style.display = 'flex';
  document.getElementById('fc-panel-title').textContent     = subjectName;
  document.getElementById('fc-panel-bar').style.background  = color;
  document.getElementById('fc-new-question').value = '';
  document.getElementById('fc-new-answer').value   = '';

  await loadFlashcardsForSubject(subjectId);
}

async function selectFlashcardSS(subjectId, subjectName, color, ssId, ssName) {
  fcSidebarSubjectId   = subjectId;
  fcSidebarSubjectName = subjectName;
  fcSidebarSsId        = ssId;
  fcSidebarSsName      = ssName;

  // Update active states
  document.querySelectorAll('.fc-subject-item, .fc-ss-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById(`fc-ss-${ssId}`);
  if (item) item.classList.add('active');

  // Show panel with subsection title
  document.getElementById('fc-subject-panel').style.display = 'flex';
  document.getElementById('fc-panel-title').textContent     = `${subjectName}  ›  ${ssName}`;
  document.getElementById('fc-panel-bar').style.background  = color;
  document.getElementById('fc-new-question').value = '';
  document.getElementById('fc-new-answer').value   = '';

  await loadFlashcardsForSS(ssId);
}

async function loadFlashcardsForSubject(subjectId) {
  try {
    const r = await fetch(`${apiBase()}/flashcards?subject_id=${subjectId}`);
    if (!r.ok) return;
    const cards = await r.json();
    flashcards[subjectId] = cards;
    renderFlashcardList(subjectId, null);
    const el = document.getElementById(`fc-count-${subjectId}`);
    if (el) el.textContent = cards.length;
  } catch(e) {}
}

async function loadFlashcardsForSS(ssId) {
  try {
    const r = await fetch(`${apiBase()}/flashcards?subsection_id=${ssId}`);
    if (!r.ok) return;
    const cards = await r.json();
    flashcards['ss_' + ssId] = cards;
    renderFlashcardList(null, ssId);
    const el = document.getElementById(`fc-count-ss-${ssId}`);
    if (el) el.textContent = cards.length;
  } catch(e) {}
}

function renderFlashcardList(subjectId, ssId) {
  const list  = document.getElementById('fc-cards-list');
  const key   = ssId ? 'ss_' + ssId : subjectId;
  const cards = flashcards[key] || [];
  const realSid = subjectId || fcSidebarSubjectId;
  const delArg  = ssId ? `'${realSid}','${ssId}'` : `'${realSid}',null`;
  if (!cards.length) {
    list.innerHTML = '<div class="fc-empty">No flashcards yet. Add your first one below!</div>';
    return;
  }
  // Build DOM elements so renderMath works properly
  list.innerHTML = '';
  cards.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'fc-card-item';
    item.id = `fcard-${c.id}`;

    const num = document.createElement('div');
    num.className = 'fc-card-num';
    num.textContent = i + 1;

    const content = document.createElement('div');
    content.className = 'fc-card-content';

    const q = document.createElement('div');
    q.className = 'fc-card-q';
    q.textContent = c.question;
    renderMath(q);

    const a = document.createElement('div');
    a.className = 'fc-card-a';
    a.textContent = c.answer || '';
    if (!c.answer) a.innerHTML = '<span style="color:var(--text3);font-style:italic">No answer yet</span>';
    else renderMath(a);

    const btn = document.createElement('button');
    btn.className = 'btn-icon';
    btn.textContent = '🗑️';
    btn.onclick = () => deleteFlashcard(realSid, ssId || null, c.id);

    content.appendChild(q);
    content.appendChild(a);
    item.appendChild(num);
    item.appendChild(content);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function updateFlashcardCount(subjectId) {
  const el = document.getElementById(`fc-count-${subjectId}`);
  if (!el) return;
  const s = subjects.find(x => x.id === subjectId);
  const ssTotal = s ? s.subsections.reduce((sum, ss) => sum + (flashcards['ss_' + ss.id] || []).length, 0) : 0;
  el.textContent = (flashcards[subjectId] || []).length + ssTotal;
}

async function addFlashcard() {
  const qInput   = document.getElementById('fc-new-question');
  const aInput   = document.getElementById('fc-new-answer');
  const question = qInput.value.trim();
  const answer   = aInput.value.trim();
  if (!question) { qInput.focus(); return; }

  // Always read from sidebar state — never rely on passed parameter
  const subjectId = fcSidebarSubjectId;
  const ssId      = fcSidebarSsId;

  if (!subjectId) {
    showToast('❌ Please select a subject first.');
    return;
  }

  const key = ssId ? 'ss_' + ssId : subjectId;

  // ── 1. OPTIMISTIC: update state + DOM instantly ─────────────
  const tempId   = 'temp_' + Date.now();
  const tempCard = { id: tempId, question, answer, subject_id: subjectId, subsection_id: ssId };
  if (!flashcards[key]) flashcards[key] = [];
  flashcards[key].push(tempCard);

  // Append card to list directly — no full re-render needed
  const list = document.getElementById('fc-cards-list');
  const emptyEl = list?.querySelector('.fc-empty');
  if (emptyEl) emptyEl.remove();
  if (list) {
    const num     = flashcards[key].length;
    const delArg  = ssId ? `'${subjectId}','${ssId}'` : `'${subjectId}',null`;
    const newItem = document.createElement('div');
    newItem.className = 'fc-card-item';
    newItem.id        = `fcard-${tempId}`;
    newItem.innerHTML = `
      <div class="fc-card-num">${num}</div>
      <div class="fc-card-content">
        <div class="fc-card-q">${esc(question)}</div>
        <div class="fc-card-a">${esc(answer) || '<span style="color:var(--text3);font-style:italic">No answer yet</span>'}</div>
      </div>
      <button class="btn-icon" onclick="deleteFlashcard(${delArg},'${tempId}')">🗑️</button>`;
    list.appendChild(newItem);
  }

  // ── 2. Update count badges instantly ────────────────────────
  // SS count badge
  const ssCountEl = ssId ? document.getElementById(`fc-count-ss-${ssId}`) : null;
  if (ssCountEl) ssCountEl.textContent = flashcards[key].length;
  // Subject count badge — always update, even for SS cards
  const subjKey     = subjectId;
  const subjCountEl = document.getElementById(`fc-count-${subjectId}`);
  // Always recompute subject total = subject-level cards + all SS cards
  if (subjCountEl) {
    const s = subjects.find(x => x.id === subjectId);
    const ssSum = s ? s.subsections.reduce((sum, ss) => sum + (flashcards['ss_' + ss.id] || []).length, 0) : 0;
    subjCountEl.textContent = (flashcards[subjectId] || []).length + ssSum;
  }

  qInput.value = ''; aInput.value = ''; qInput.focus();

  // ── 3. Background API call ───────────────────────────────────
  try {
    const r = await fetch(`${apiBase()}/flashcards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: subjectId, subsection_id: ssId || null, question, answer })
    });
    if (!r.ok) throw new Error();
    const real = await r.json();

    // ── 4. Silently swap tempId → real ID ────────────────────
    const idx = flashcards[key].findIndex(c => c.id === tempId);
    if (idx !== -1) flashcards[key][idx] = real;

    // Also make sure subject-level cache has this card if it's a subject-level card
    if (!ssId) {
      if (!flashcards[subjectId]) flashcards[subjectId] = [];
      const alreadyIn = flashcards[subjectId].find(c => c.id === real.id);
      if (!alreadyIn) {
        // Replace temp entry if present, otherwise push
        const tidx = flashcards[subjectId].findIndex(c => c.id === tempId);
        if (tidx !== -1) flashcards[subjectId][tidx] = real;
        else flashcards[subjectId].push(real);
      }
    }

    // Swap in DOM without re-rendering
    const tempEl = document.getElementById(`fcard-${tempId}`);
    if (tempEl) {
      tempEl.id = `fcard-${real.id}`;
      const delBtn = tempEl.querySelector('.btn-icon');
      const delArg = ssId ? `'${subjectId}','${ssId}'` : `'${subjectId}',null`;
      if (delBtn) delBtn.setAttribute('onclick', `deleteFlashcard(${delArg},'${real.id}')`);
    }

  } catch(e) {
    // ── 5. Rollback on failure ───────────────────────────────
    flashcards[key] = flashcards[key].filter(c => c.id !== tempId);
    document.getElementById(`fcard-${tempId}`)?.remove();
    if (flashcards[key].length === 0) {
      const list2 = document.getElementById('fc-cards-list');
      if (list2) list2.innerHTML = '<div class="fc-empty">No flashcards yet. Add your first one below!</div>';
    }
    if (ssCountEl) ssCountEl.textContent = flashcards[key].length;
    if (subjCountEl) subjCountEl.textContent = Math.max(0, parseInt(subjCountEl.textContent || 0) - 1);
    showToast('❌ Failed to save flashcard. Please try again.');
  }
}

async function deleteFlashcard(subjectId, ssId, cardId) {
  const key  = ssId ? 'ss_' + ssId : subjectId;
  const prev = [...(flashcards[key] || [])];

  // Find the card BEFORE removing — need its subsection_id if deleting from subject view
  const card = flashcards[key].find(c => c.id === cardId);
  const cardSsId = ssId || card?.subsection_id || null;

  // 1. Remove from state instantly
  flashcards[key] = flashcards[key].filter(c => c.id !== cardId);

  // If deleting from subject view and card belongs to a subsection,
  // also remove it from the SS cache so counts stay in sync
  if (!ssId && cardSsId) {
    const ssKey = 'ss_' + cardSsId;
    if (flashcards[ssKey]) {
      flashcards[ssKey] = flashcards[ssKey].filter(c => c.id !== cardId);
      // Update SS badge immediately
      const ssCountEl2 = document.getElementById(`fc-count-ss-${cardSsId}`);
      if (ssCountEl2) ssCountEl2.textContent = flashcards[ssKey].length;
    }
  }

  // 2. Remove card from DOM instantly
  document.getElementById(`fcard-${cardId}`)?.remove();
  if (flashcards[key].length === 0) {
    const list = document.getElementById('fc-cards-list');
    if (list) list.innerHTML = '<div class="fc-empty">No flashcards yet. Add your first one below!</div>';
  }

  // 3. Update SS count badge (when deleting from SS view)
  const ssCountEl = ssId ? document.getElementById(`fc-count-ss-${ssId}`) : null;
  if (ssCountEl) ssCountEl.textContent = flashcards[key].length;

  // 4. Update parent subject count badge
  const subjCountEl = document.getElementById(`fc-count-${subjectId}`);
  if (subjCountEl) {
    const current = parseInt(subjCountEl.textContent || '0');
    subjCountEl.textContent = Math.max(0, current - 1);
  }

  // 5. Background API call
  try {
    const r = await fetch(`${apiBase()}/flashcards/${cardId}`, { method: 'DELETE' });
    if (!r.ok) throw new Error();
  } catch(e) {
    // Rollback everything
    flashcards[key] = prev;
    if (!ssId && cardSsId) {
      const ssKey = 'ss_' + cardSsId;
      if (flashcards[ssKey] && !flashcards[ssKey].find(c => c.id === cardId)) {
        flashcards[ssKey].push(card);
      }
      const ssCountEl2 = document.getElementById(`fc-count-ss-${cardSsId}`);
      if (ssCountEl2) ssCountEl2.textContent = (flashcards['ss_' + cardSsId] || []).length;
    }
    renderFlashcardList(ssId ? null : subjectId, ssId);
    if (ssCountEl) ssCountEl.textContent = prev.length;
    if (subjCountEl) subjCountEl.textContent = parseInt(subjCountEl.textContent || '0') + 1;
    showToast('❌ Failed to delete. Please try again.');
  }
}

// ══════════════════════════════════════════════════════════════
//  FLASHCARD QUIZ
// ══════════════════════════════════════════════════════════════

let quizCards    = [];
let quizIndex    = 0;
let quizGot      = 0;
let quizMissed   = 0;
let quizRevealed = false;

async function openFlashcardQuiz(subjectId, subjectName, color, ssId, ssName) {
  const key   = ssId ? 'ss_' + ssId : subjectId;
  const label = ssId ? `${subjectName}  ›  ${ssName}` : subjectName;

  // Load cards if not already loaded
  if (ssId) {
    // SS quiz — load just this subsection
    if (!flashcards[key]) await loadFlashcardsForSS(ssId);
  } else {
    // Subject quiz — load subject-level AND all subsection cards
    if (!flashcards[subjectId]) await loadFlashcardsForSubject(subjectId);
    const s = subjects.find(x => x.id === subjectId);
    if (s) {
      for (const ss of s.subsections) {
        if (!flashcards['ss_' + ss.id]) await loadFlashcardsForSS(ss.id);
      }
    }
  }

  // Collect all cards for this quiz
  let cards = [];
  if (ssId) {
    cards = flashcards[key] || [];
  } else {
    // Subject quiz = subject-level cards + all subsection cards combined
    const s = subjects.find(x => x.id === subjectId);
    cards = [...(flashcards[subjectId] || [])];
    if (s) {
      s.subsections.forEach(ss => {
        cards = cards.concat(flashcards['ss_' + ss.id] || []);
      });
    }
  }

  if (!cards.length) {
    showToast('🎴 No flashcards yet! Open the 🎴 panel to add some.');
    return;
  }

  quizCards    = [...cards].sort(() => Math.random() - 0.5);
  quizIndex    = 0;
  quizGot      = 0;
  quizMissed   = 0;
  quizRevealed = false;

  document.getElementById('quiz-subject-name').textContent     = label;
  document.getElementById('quiz-subject-bar').style.background = color;
  openModal('quizModal');
  renderQuizCard();
}

function renderQuizCard() {
  const total = quizCards.length;
  const card  = quizCards[quizIndex];
  const pct   = Math.round((quizIndex / total) * 100);

  document.getElementById('quiz-progress-fill').style.width = pct + '%';
  document.getElementById('quiz-counter').textContent       = `${quizIndex + 1} / ${total}`;
  document.getElementById('quiz-got-count').textContent     = quizGot;
  document.getElementById('quiz-missed-count').textContent  = quizMissed;
  const qEl = document.getElementById('quiz-question');
  const aEl = document.getElementById('quiz-answer');
  qEl.textContent = card.question;
  renderMath(qEl);
  aEl.textContent = card.answer || '(No answer provided)';
  renderMath(aEl);
  aEl.style.display      = 'none';
  document.getElementById('quiz-reveal-btn').style.display  = 'block';
  document.getElementById('quiz-answer-btns').style.display = 'none';
  document.getElementById('quiz-card-area').style.display   = 'block';
  document.getElementById('quiz-result-area').style.display = 'none';
  quizRevealed = false;
}

function revealQuizAnswer() {
  document.getElementById('quiz-answer').style.display      = 'block';
  document.getElementById('quiz-reveal-btn').style.display  = 'none';
  document.getElementById('quiz-answer-btns').style.display = 'flex';
  quizRevealed = true;
}

function answerQuiz(correct) {
  if (!quizRevealed) return;
  if (correct) quizGot++; else quizMissed++;
  quizIndex++;
  if (quizIndex >= quizCards.length) {
    showQuizResult();
  } else {
    renderQuizCard();
  }
}

function showQuizResult() {
  const total = quizCards.length;
  const pct   = Math.round((quizGot / total) * 100);
  const emoji = pct >= 80 ? '🎉' : pct >= 50 ? '👍' : '💪';
  const msg   = pct >= 80 ? 'Excellent work!' : pct >= 50 ? 'Good progress!' : 'Keep reviewing!';

  // Update header stats FIRST so last answer is reflected
  document.getElementById('quiz-got-count').textContent    = quizGot;
  document.getElementById('quiz-missed-count').textContent = quizMissed;
  document.getElementById('quiz-progress-fill').style.width = '100%';
  document.getElementById('quiz-counter').textContent       = `${total} / ${total}`;
  document.getElementById('quiz-card-area').style.display   = 'none';
  document.getElementById('quiz-result-area').style.display = 'block';
  document.getElementById('quiz-result-emoji').textContent  = emoji;
  document.getElementById('quiz-result-msg').textContent    = msg;
  document.getElementById('quiz-result-score').textContent  = `${quizGot} / ${total} correct (${pct}%)`;
  document.getElementById('quiz-got-final').textContent     = quizGot;
  document.getElementById('quiz-missed-final').textContent  = quizMissed;
}

function retryQuiz() {
  quizCards    = [...quizCards].sort(() => Math.random() - 0.5);
  quizIndex    = 0;
  quizGot      = 0;
  quizMissed   = 0;
  quizRevealed = false;
  renderQuizCard();
}

// ══════════════════════════════════════════════════════════════
//  PDF → FLASHCARD GENERATION
// ══════════════════════════════════════════════════════════════

let pdfGeneratedCards = [];  // cards returned from Gemini
let pdfSelectedCards  = [];  // which ones the user checked
let pdfFile           = null;

function openPdfGenerateModal() {
  if (!isPro()) {
    showToast('⭐ This feature requires a Pro account.');
    return;
  }
  if (!fcSidebarSubjectId) {
    showToast('❌ Please select a subject first.');
    return;
  }

  // Reset state safely
  pdfFile = null;
  pdfGeneratedCards = [];
  pdfSelectedCards  = [];

  const safeSet = (id, prop, val) => { const el = document.getElementById(id); if (el) el[prop] = val; };
  const safeStyle = (id, prop, val) => { const el = document.getElementById(id); if (el) el.style[prop] = val; };

  safeSet('pdfFileInput', 'value', '');
  safeStyle('pdfFileChosen', 'display', 'none');
  safeStyle('pdfDropZone',   'display', 'block');
  safeSet('pdfCardCount',  'value', '10');
  safeSet('pdfCountLabel', 'textContent', '10');
  // Ensure label stays in sync with slider
  const sliderEl = document.getElementById('pdfCardCount');
  if (sliderEl) sliderEl.dispatchEvent(new Event('input'));
  safeStyle('pdfError', 'display', 'none');
  safeSet('pdfError', 'textContent', '');
  safeSet('pdfGenerateBtn', 'disabled', false);
  safeSet('pdfGenerateBtn', 'textContent', '✨ Generate Flashcards');

  // Show subject name in subtitle
  const label = fcSidebarSsId
    ? `${fcSidebarSubjectName} › ${fcSidebarSsName}`
    : fcSidebarSubjectName;
  safeSet('pdfModalSubject', 'textContent', label);

  showPdfStep(1);

  // Open modal — must use high z-index so it appears above the sidebar
  const modal = document.getElementById('pdfGenerateModal');
  if (modal) {
    modal.style.zIndex = '500';  // above sidebar (200) and existing modals (300)
    modal.classList.add('open');
    modal.style.display = 'flex';
  }
}

function closePdfModal() {
  const modal = document.getElementById('pdfGenerateModal');
  if (modal) {
    modal.classList.remove('open');
    modal.style.display = 'none';
  }
  pdfFile = null;
  pdfGeneratedCards = [];
}

function showPdfStep(step) {
  [1, 2, 3].forEach(n => {
    const el = document.getElementById(`pdfStep${n}`);
    if (el) el.style.display = (n === step) ? 'block' : 'none';
  });
}

function handlePdfDrop(event) {
  event.preventDefault();
  document.getElementById('pdfDropZone').classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) setPdfFile(file);
}

function handlePdfSelect(event) {
  const file = event.target.files[0];
  if (file) setPdfFile(file);
}

function setPdfFile(file) {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    showPdfError('Please upload a PDF file.');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showPdfError('File is too large. Maximum size is 20MB.');
    return;
  }
  pdfFile = file;
  document.getElementById('pdfFileName').textContent    = file.name;
  document.getElementById('pdfFileChosen').style.display = 'flex';
  document.getElementById('pdfDropZone').style.display   = 'none';
  document.getElementById('pdfError').style.display      = 'none';
}

function clearPdfFile() {
  pdfFile = null;
  document.getElementById('pdfFileInput').value          = '';
  document.getElementById('pdfFileChosen').style.display = 'none';
  document.getElementById('pdfDropZone').style.display   = 'block';
}

function showPdfError(msg) {
  const el = document.getElementById('pdfError');
  el.textContent    = msg;
  el.style.display  = 'block';
}

async function startPdfGeneration() {
  if (!pdfFile) {
    showPdfError('Please upload a PDF file first.');
    return;
  }
  if (!fcSidebarSubjectId) {
    showPdfError('No subject selected. Please close and select a subject.');
    return;
  }

  const slider    = document.getElementById('pdfCardCount');
  const maxCards  = slider ? Math.round(parseFloat(slider.value)) : 10;
  const subjectName  = fcSidebarSubjectName || 'this subject';

  // ── Show loading step ───────────────────────────────────────
  showPdfStep(2);
  animatePdfLoading();

  try {
    const formData = new FormData();
    formData.append('pdf',          pdfFile);
    formData.append('max_cards',    maxCards);
    formData.append('subject_name', subjectName);

    const r = await fetch(`${apiBase()}/generate-pdf-flashcards`, {
      method: 'POST',
      body: formData   // NO Content-Type header — browser sets multipart boundary
    });

    // Safely parse response — server might return HTML on 500 errors
    let data;
    const contentType = r.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await r.json();
    } else {
      const text = await r.text();
      console.error('Non-JSON response:', text.substring(0, 200));
      showPdfStep(1);
      showPdfError(`Server error (${r.status}). Please try again.`);
      return;
    }

    if (!r.ok) {
      showPdfStep(1);
      showPdfError(data.error || 'Generation failed. Please try again.');
      return;
    }

    pdfGeneratedCards = data.flashcards || [];
    pdfSelectedCards  = pdfGeneratedCards.map((_, i) => i);  // all selected by default

    // ── Show preview step ─────────────────────────────────────
    showPdfStep(3);
    document.getElementById('pdfPreviewCount').textContent =
      `${pdfGeneratedCards.length} flashcard${pdfGeneratedCards.length !== 1 ? 's' : ''} generated`;
    renderPdfPreview();

  } catch(e) {
    showPdfStep(1);
    showPdfError(`Error: ${e.message || 'Unknown error. Please try again.'}`);
    console.error('PDF generation error:', e);
  }
}

function animatePdfLoading() {
  const messages = [
    'Reading your PDF…',
    'Extracting key concepts…',
    'Generating questions…',
    'Crafting answers…',
    'Finalizing flashcards…'
  ];
  let i = 0;
  const textEl = document.getElementById('pdfLoadingText');
  const barEl  = document.getElementById('pdfLoadingBar');
  if (textEl) textEl.textContent = messages[0];
  if (barEl)  barEl.style.width  = '10%';

  const interval = setInterval(() => {
    i++;
    if (i >= messages.length) { clearInterval(interval); return; }
    const pct = Math.round(((i + 1) / messages.length) * 85);
    if (textEl) textEl.textContent = messages[i];
    if (barEl)  barEl.style.width  = pct + '%';
  }, 2500);
}

function renderPdfPreview() {
  const list = document.getElementById('pdfPreviewList');
  if (!list) return;

  list.innerHTML = '';
  pdfGeneratedCards.forEach((card, i) => {
    const checked = pdfSelectedCards.includes(i);
    const item = document.createElement('div');
    item.className = `pdf-preview-card ${checked ? 'selected' : ''}`;
    item.id = `pdf-card-${i}`;
    item.onclick = () => togglePdfCard(i);

    const checkWrap = document.createElement('div');
    checkWrap.className = 'pdf-preview-check';
    const checkBox = document.createElement('div');
    checkBox.className = `pdf-check-box ${checked ? 'checked' : ''}`;
    checkBox.textContent = checked ? '✓' : '';
    checkWrap.appendChild(checkBox);

    const content = document.createElement('div');
    content.className = 'pdf-preview-content';

    const q = document.createElement('div');
    q.className = 'pdf-preview-q';
    q.textContent = card.question;
    renderMath(q);

    const a = document.createElement('div');
    a.className = 'pdf-preview-a';
    a.textContent = card.answer;
    renderMath(a);

    content.appendChild(q);
    content.appendChild(a);
    item.appendChild(checkWrap);
    item.appendChild(content);
    list.appendChild(item);
  });

  updatePdfSelectedCount();
}

function togglePdfCard(index) {
  const pos = pdfSelectedCards.indexOf(index);
  if (pos !== -1) {
    pdfSelectedCards.splice(pos, 1);
  } else {
    pdfSelectedCards.push(index);
  }

  // Update card UI
  const card  = document.getElementById(`pdf-card-${index}`);
  const check = card?.querySelector('.pdf-check-box');
  const selected = pdfSelectedCards.includes(index);
  if (card)  card.classList.toggle('selected', selected);
  if (check) { check.classList.toggle('checked', selected); check.textContent = selected ? '✓' : ''; }

  updatePdfSelectedCount();
}

function pdfSelectAll(select) {
  pdfSelectedCards = select ? pdfGeneratedCards.map((_, i) => i) : [];
  renderPdfPreview();
}

function updatePdfSelectedCount() {
  const el = document.getElementById('pdfSelectedCount');
  if (el) el.textContent = `${pdfSelectedCards.length} selected`;
  const saveBtn = document.getElementById('pdfSaveBtn');
  if (saveBtn) saveBtn.disabled = pdfSelectedCards.length === 0;
}

async function savePdfFlashcards() {
  if (!pdfSelectedCards.length) {
    showToast('Select at least one flashcard to save.');
    return;
  }

  const saveBtn = document.getElementById('pdfSaveBtn');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  const cardsToSave = pdfSelectedCards
    .sort((a, b) => a - b)
    .map(i => pdfGeneratedCards[i]);

  let saved = 0;
  let failed = 0;

  for (const card of cardsToSave) {
    try {
      // Optimistically add to local cache immediately
      const subjectId = fcSidebarSubjectId;
      const ssId      = fcSidebarSsId;
      const key       = ssId ? 'ss_' + ssId : subjectId;
      const tempId    = 'temp_pdf_' + Date.now() + '_' + saved;
      const tempCard  = { id: tempId, question: card.question, answer: card.answer,
                          subject_id: subjectId, subsection_id: ssId };
      if (!flashcards[key]) flashcards[key] = [];
      flashcards[key].push(tempCard);

      // Save to server
      const r = await fetch(`${apiBase()}/flashcards`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject_id:    subjectId,
          subsection_id: ssId || null,
          question:      card.question,
          answer:        card.answer
        })
      });

      if (r.ok) {
        const real = await r.json();
        const idx  = flashcards[key].findIndex(c => c.id === tempId);
        if (idx !== -1) flashcards[key][idx] = real;
        saved++;
      } else {
        // Remove temp on failure
        flashcards[key] = flashcards[key].filter(c => c.id !== tempId);
        failed++;
      }
    } catch(e) {
      failed++;
    }
  }

  closePdfModal();

  // Refresh card list if this subject/ss is currently open
  if (fcSidebarSubjectId) {
    const key = fcSidebarSsId ? 'ss_' + fcSidebarSsId : fcSidebarSubjectId;
    renderFlashcardList(fcSidebarSsId ? null : fcSidebarSubjectId, fcSidebarSsId);
    updateFlashcardCount(fcSidebarSubjectId);
    // Update subject count badge
    const subjCountEl = document.getElementById(`fc-count-${fcSidebarSubjectId}`);
    if (subjCountEl) {
      const s = subjects.find(x => x.id === fcSidebarSubjectId);
      const ssSum = s ? s.subsections.reduce((sum, ss) => sum + (flashcards['ss_' + ss.id] || []).length, 0) : 0;
      subjCountEl.textContent = (flashcards[fcSidebarSubjectId] || []).length + ssSum;
    }
    // Update SS count badge if applicable
    if (fcSidebarSsId) {
      const ssCountEl = document.getElementById(`fc-count-ss-${fcSidebarSsId}`);
      if (ssCountEl) ssCountEl.textContent = (flashcards['ss_' + fcSidebarSsId] || []).length;
    }
  }

  if (failed === 0) {
    showToast(`✅ ${saved} flashcard${saved !== 1 ? 's' : ''} saved successfully!`);
  } else {
    showToast(`✅ ${saved} saved, ❌ ${failed} failed. Please try again for the failed ones.`);
  }
}


// ══════════════════════════════════════════════════════════════
//  STANDALONE LOGIN (username or email)
// ══════════════════════════════════════════════════════════════

async function doStandaloneLogin() {
  const identifier = document.getElementById('standalone-login-identifier').value.trim();
  const password   = document.getElementById('standalone-login-password').value;
  const errEl      = document.getElementById('standalone-login-error');
  const btn        = document.getElementById('standalone-login-btn');
  errEl.textContent = '';

  if (!identifier) { errEl.textContent = 'Please enter your username or email.'; return; }
  if (!password)   { errEl.textContent = 'Please enter your password.'; return; }

  btn.textContent = 'Logging in…';
  btn.disabled = true;

  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 403) {
        // Account paused — show dedicated paused view
        showView('paused');
        return;
      }
      errEl.textContent = data.error || 'Incorrect username/email or password.';
      return;
    }
    currentUser = data;
    await enterTracker();
  } catch(e) {
    errEl.textContent = 'Connection error. Please try again.';
  } finally {
    btn.textContent = 'Log In';
    btn.disabled = false;
  }
}

function openForgotPasswordStandalone() {
  const identifier = document.getElementById('standalone-login-identifier').value.trim();
  document.getElementById('forgot-email').value = identifier.includes('@') ? identifier : '';
  document.getElementById('forgot-error').textContent = '';
  const succ = document.getElementById('forgot-success');
  if (succ) { succ.style.display = 'none'; succ.textContent = ''; }
  showView('forgot');
  setTimeout(() => document.getElementById('forgot-email')?.focus(), 150);
}


function toggleLandingFaq(btn) {
  const item = btn.closest('.faq-item');
  const wasOpen = item.classList.contains('open');
  document.querySelectorAll('.landing-faq .faq-item').forEach(i => i.classList.remove('open'));
  if (!wasOpen) item.classList.add('open');
}


boot();