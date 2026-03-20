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
    fetch('/api/auth/me-full')
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
  loadProfiles();
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
    try { localStorage.removeItem(MOTIVATION_CACHE_KEY()); } catch(e) {}

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
  showView('tracker');
  try { showPomodoroFab(); }     catch(e) {}
  try { renderSubjectsGrid(); renderProgressOverview(); } catch(e) {}
  try { renderNotes(); }         catch(e) {}
  try { fetchMotivation(); } catch(e) {}
}

async function enterTracker() {
  // Fetch subjects + notes then render (used after login/register)
  try { updateHeaderProfile(); } catch(e) {}
  try { updateCountdown(); }     catch(e) {}
  showView('tracker');
  try { showPomodoroFab(); }     catch(e) {}
  try {
    // Use me-full to get everything in one request
    const r = await fetch('/api/auth/me-full');
    if (r.ok) {
      const full = await r.json();
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


  // Handle avatar changes
  if (avatarDataUrl === 'remove') {
      try {
      const r = await fetch(`/api/profiles/${uid}/avatar`, { method: 'DELETE' });
      const text = await r.text();
          let d;
      try { d = JSON.parse(text); } catch(e) { errEl.textContent = 'Server error removing picture.'; return; }
      if (!r.ok) { errEl.textContent = d.error || `Error ${r.status} removing picture.`; return; }
      currentUser = d;
        } catch(fetchErr) {
          errEl.textContent = 'Network error removing picture.';
      return;
    }
  } else if (avatarDataUrl && avatarDataUrl !== null) {
    // User picked a new photo — upload it
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
  const examDateVal    = document.getElementById('profileExamDate').value;
  const newUsername    = document.getElementById('profileUsername').value.trim().toLowerCase();
  const body = {
    username:     newUsername,
    display_name: document.getElementById('profileDisplayName').value.trim(),
    exam_date:    examDateVal || null
  };
  const newPw = document.getElementById('profileNewPw').value;
  if (newPw) {
    body.new_password     = newPw;
    body.current_password = document.getElementById('profileCurrentPw').value;
  }

  // Keep the avatar state we already handled above
  const avatarBeforeSave = currentUser.avatar;

  const r2 = await fetch(`/api/profiles/${uid}/settings`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const d2 = await r2.json();
  if (!r2.ok) { errEl.textContent = d2.error; return; }

  // Merge settings response but preserve the avatar we already handled
  currentUser = { ...currentUser, ...d2 };
  if (avatarDataUrl === 'remove') {
    currentUser.avatar = null;  // force null — don't let stale cache restore it
    } else if (avatarDataUrl === null) {
    currentUser.avatar = avatarBeforeSave;  // unchanged — keep existing
    }
  // if avatarDataUrl is a new upload, currentUser.avatar already updated above

  updateHeaderProfile();
  updateCountdown();
  closeModal('profileModal');
  showToast('Profile updated! ✅');
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
        <button class="btn-icon" title="Edit" onclick="openEditSubjectModal('${subject.id}')">✏️</button>
        <button class="btn-icon" title="Delete" onclick="confirmDelete('subject','${subject.id}')">🗑️</button>
      </div>
    </div>
    <div class="card-body" id="card-body-${subject.id}">
      <div id="ss-list-${subject.id}">
        ${subject.subsections.map(ss => buildSubsectionHTML(subject.id, ss)).join('')}
      </div>
      <div class="add-subsection-row">
        <input class="inline-input" id="ss-input-${subject.id}" placeholder="Add sub-subject…"
               onkeydown="handleSSEnter(event,'${subject.id}')"/>
        <button class="btn-add-inline" onclick="quickAddSubsection('${subject.id}')">+ Add</button>
      </div>
    </div>`;
  return card;
}

function buildSubsectionHTML(subjectId, ss) {
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
  return `
  <div class="topic-item" id="t-${t.id}">
    <div class="topic-checkbox ${t.done ? 'checked':''}" id="t-cb-${t.id}"
         onclick="toggleTopicDone('${subjectId}','${ssId}','${t.id}')">${t.done ? '✓':''}</div>
    <span class="topic-name ${t.done ? 'done-text':''}" id="t-name-${t.id}">${esc(t.name)}</span>
    <button class="btn-icon" onclick="confirmDelete('topic','${subjectId}','${ssId}','${t.id}')">🗑️</button>
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
  root.querySelectorAll('[id]').forEach(el => {
    el.id = el.id.replaceAll(tempId, realId);
  });
  root.querySelectorAll('[onclick]').forEach(el => {
    el.setAttribute('onclick', el.getAttribute('onclick').replaceAll(tempId, realId));
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
  const cb = document.getElementById(`ss-cb-${ssId}`);
  const nm = document.getElementById(`ss-name-${ssId}`);
  const pe = document.getElementById(`ss-pct-${ssId}`);
  if (cb) { cb.className = 'custom-checkbox' + (ss.done ? ' checked' : ''); cb.textContent = ss.done ? '✓' : ''; }
  if (nm) nm.className = 'subsection-name' + (ss.done ? ' done-text' : '');
  const td = ss.topics.filter(t => t.done).length, tt = ss.topics.length;
  const pct = tt === 0 ? (ss.done ? 100 : 0) : Math.round((td / tt) * 100);
  if (pe) pe.textContent = pct + '%';
  refreshCardProgress(subjectId);
  fetch(`${apiBase()}/subjects/${subjectId}/subsections/${ssId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ done: ss.done })
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
  fetch(`${apiBase()}/subjects/${subjectId}/subsections/${ssId}/topics/${topicId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ done: t.done })
  });
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
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
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
  const cacheKey = 'boardprep_daily_' + (currentUser ? currentUser.id : 'anon') + '_' + todayKey;

  // Same day — serve from cache
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.message) {
      renderMotivation(cached.message, cached.tip, todayKey);
      return;
    }
  } catch(e) {}

  if (loading) loading.style.display = 'block';
  if (msgEl)   msgEl.style.display   = 'none';
  if (footer)  footer.style.display  = 'none';
  if (tipEl)   tipEl.style.display   = 'none';

  let message = null;

  // Try Gemini — completely silent fallback on any failure
  const geminiKey = window.__GEMINI_KEY__;
  if (geminiKey && geminiKey !== 'REPLACE_WITH_YOUR_GEMINI_KEY') {
    try {
      const subNames = subjects.map(function(s) { return s.name; }).slice(0, 5).join(', ') || 'board exam subjects';
      const pData = subjects.reduce(function(a, s) {
        const p = subjectProgress(s);
        return { t: a.t + p.total, d: a.d + p.done };
      }, { t: 0, d: 0 });
      const pct = pData.t === 0 ? 0 : Math.round((pData.d / pData.t) * 100);
      const prompt = 'Write a short motivational message (3-4 sentences, under 70 words) for ' + name + ', a Filipino board exam reviewer. Subjects: ' + subNames + '. Progress: ' + pct + '% done. Use one natural Tagalog word. No bullet points. End with one short powerful sentence.';

      const resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 150, temperature: 0.9 } }) }
      );
      if (resp.ok) {
        const data = await resp.json();
        const candidate = data.candidates && data.candidates[0];
        const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
        if (part && part.text) message = part.text.trim();
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

boot();