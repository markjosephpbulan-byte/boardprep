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

  // Load Gemini API key from backend (keeps it out of source code)
  try {
    const r = await fetch('/api/config');
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.gemini_key) window.__GEMINI_KEY__ = cfg.gemini_key;
    }
  } catch(e) {}

  // Check if already logged in
  try {
    const r = await fetch('/api/auth/me');
    if (r.ok) {
      currentUser = await r.json();
      await enterTracker();
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
    const els = {
      'subjectsGrid':          el => el.innerHTML = '',
      'subjectProgressStrip':  el => el.innerHTML = '',
      'overallFill':           el => el.style.width = '0%',
      'overallPct':            el => el.textContent = '0%',
      'notesList':             el => el.innerHTML = '',
      'notesBadge':            el => el.textContent = '0',
      'countdownChip':         el => el.style.display = 'none',
    };
    Object.entries(els).forEach(([id, fn]) => {
      const el = document.getElementById(id);
      if (el) fn(el);
    });
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
    resetPomodoro();
    document.getElementById('pomodoroFab').style.display = 'none';
    document.getElementById('pomodoroWidget').style.display = 'none';
    showView('landing');
    loadProfiles();
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
async function enterTracker() {
  updateHeaderProfile();
  updateCountdown();
  showView('tracker');
  showPomodoroFab();
  await Promise.all([loadSubjects(), loadNotes()]);
  fetchMotivation(false);  // load daily motivation (false = use cached if same day)
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

  // Upload avatar if changed
  if (avatarDataUrl && avatarDataUrl !== 'remove') {
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

  const r2 = await fetch(`/api/profiles/${uid}/settings`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const d2 = await r2.json();
  if (!r2.ok) { errEl.textContent = d2.error; return; }

  currentUser = { ...currentUser, ...d2 };
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
  const empty = document.getElementById('emptyState');
  if (subjects.length === 0) {
    grid.innerHTML = '';
    grid.appendChild(empty);
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = '';
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
async function saveSubject() {
  const name  = document.getElementById('subjectNameInput').value.trim();
  if (!name) { showToast('Please enter a subject name'); return; }
  const color = getSelectedColor('subjectColorPicker') || SUBJECT_COLORS[0];
  if (ctx.mode === 'add') {
    const r = await fetch(`${apiBase()}/subjects`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, color })
    });
    const s = await r.json();
    subjects.push(s);
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('subjectsGrid').appendChild(buildSubjectCard(s));
    const strip = document.getElementById('subjectProgressStrip');
    const chip  = document.createElement('div');
    chip.className = 'subject-chip'; chip.id = `chip-${s.id}`;
    chip.innerHTML = `
      <div class="chip-dot" style="background:${s.color}"></div>
      <span style="font-size:0.78rem;color:var(--text2)">${esc(s.name)}</span>
      <div class="chip-bar-wrap"><div class="chip-bar-fill" id="chip-bar-${s.id}" style="background:${s.color};width:0%"></div></div>
      <span class="chip-pct" id="chip-pct-${s.id}" style="color:${s.color}">0%</span>`;
    strip.appendChild(chip);
    showToast('Subject added!');
  } else {
    await fetch(`${apiBase()}/subjects/${ctx.id}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, color })
    });
    const idx = subjects.findIndex(x => x.id === ctx.id);
    if (idx !== -1) { subjects[idx].name = name; subjects[idx].color = color; }
    const card = document.getElementById(`subject-${ctx.id}`);
    if (card) {
      card.querySelector('.card-title').textContent = name;
      card.querySelector('.card-color-bar').style.background = color;
      card.querySelector('.card-bar-fill').style.background  = color;
      card.querySelector('.card-pct').style.color = color;
    }
    showToast('Subject updated!');
  }
  closeModal('subjectModal');
}

// ── Subsections ───────────────────────────────────────────────
async function quickAddSubsection(subjectId) {
  const input = document.getElementById(`ss-input-${subjectId}`);
  const name  = input.value.trim();
  if (!name) return;
  const r  = await fetch(`${apiBase()}/subjects/${subjectId}/subsections`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name })
  });
  const ss = await r.json();
  const s = subjects.find(x => x.id === subjectId);
  if (s) s.subsections.push(ss);
  const list = document.getElementById(`ss-list-${subjectId}`);
  if (list) list.insertAdjacentHTML('beforeend', buildSubsectionHTML(subjectId, ss));
  input.value = '';
  refreshCardProgress(subjectId);
  showToast('Sub-subject added!');
}
function handleSSEnter(e, id) { if (e.key === 'Enter') quickAddSubsection(id); }

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
  const r = await fetch(`${apiBase()}/subjects/${subjectId}/subsections/${ssId}/topics`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name })
  });
  const t  = await r.json();
  const s  = subjects.find(x => x.id === subjectId);
  const ss = s?.subsections.find(x => x.id === ssId);
  if (ss) ss.topics.push(t);
  const list = document.getElementById(`topic-list-${ssId}`);
  if (list) list.insertAdjacentHTML('beforeend', buildTopicHTML(subjectId, ssId, t));
  const body   = document.getElementById(`ssb-${ssId}`);
  const toggle = document.getElementById(`sst-${ssId}`);
  if (body) body.style.display = 'block';
  if (toggle) toggle.classList.add('open');
  if (ss) {
    const d = ss.topics.filter(tp => tp.done).length;
    const pe = document.getElementById(`ss-pct-${ssId}`);
    if (pe) pe.textContent = Math.round((d / ss.topics.length) * 100) + '%';
  }
  input.value = '';
  refreshCardProgress(subjectId);
  showToast('Topic added!');
}
function handleTopicEnter(e, sid, ssid) { if (e.key === 'Enter') quickAddTopic(sid, ssid); }

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
  if (ctx.mode === 'add') {
    const r = await fetch(`${apiBase()}/notes`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ title, content, color })
    });
    const n = await r.json();
    notes.unshift(n);
    showToast('Note saved!');
  } else {
    await fetch(`${apiBase()}/notes/${ctx.id}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ title, content, color })
    });
    const idx = notes.findIndex(x => x.id === ctx.id);
    if (idx !== -1) { notes[idx] = { ...notes[idx], title, content, color, updated_at: new Date().toISOString() }; }
    showToast('Note updated!');
  }
  closeModal('noteModal');
  renderNotes();
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
    await fetch(`${apiBase()}/subjects/${ids[0]}`, { method: 'DELETE' });
    subjects = subjects.filter(x => x.id !== ids[0]);
    document.getElementById(`subject-${ids[0]}`)?.remove();
    document.getElementById(`chip-${ids[0]}`)?.remove();
    if (!subjects.length) { const g = document.getElementById('subjectsGrid'); const e = document.getElementById('emptyState'); g.appendChild(e); e.style.display = 'block'; }
    refreshOverallProgress();
    showToast('Subject deleted');
  } else if (type === 'subsection') {
    const [sid, ssid] = ids;
    await fetch(`${apiBase()}/subjects/${sid}/subsections/${ssid}`, { method: 'DELETE' });
    const s = subjects.find(x => x.id === sid);
    if (s) s.subsections = s.subsections.filter(x => x.id !== ssid);
    document.getElementById(`ss-${ssid}`)?.remove();
    refreshCardProgress(sid);
    showToast('Sub-subject deleted');
  } else if (type === 'topic') {
    const [sid, ssid, tid] = ids;
    await fetch(`${apiBase()}/subjects/${sid}/subsections/${ssid}/topics/${tid}`, { method: 'DELETE' });
    const s = subjects.find(x => x.id === sid);
    const ss = s?.subsections.find(x => x.id === ssid);
    if (ss) ss.topics = ss.topics.filter(x => x.id !== tid);
    document.getElementById(`t-${tid}`)?.remove();
    if (ss) { const pe = document.getElementById(`ss-pct-${ssid}`); const d = ss.topics.filter(t => t.done).length; if (pe) pe.textContent = (ss.topics.length ? Math.round((d / ss.topics.length) * 100) : 0) + '%'; }
    refreshCardProgress(sid);
    showToast('Topic deleted');
  } else if (type === 'note') {
    await fetch(`${apiBase()}/notes/${ids[0]}`, { method: 'DELETE' });
    notes = notes.filter(x => x.id !== ids[0]);
    renderNotes();
    showToast('Note deleted');
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
boot();

// ══════════════════════════════════════════════════════════════
//  COUNTDOWN TIMER
// ══════════════════════════════════════════════════════════════

function updateCountdown() {
  const chip = document.getElementById('countdownChip');
  const daysEl = document.getElementById('countdownDays');
  const labelEl = document.getElementById('countdownLabel');

  if (!currentUser || !currentUser.exam_date) {
    chip.style.display = 'none';
    return;
  }

  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const examDate = new Date(currentUser.exam_date + 'T00:00:00');
  const diffMs   = examDate - today;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  chip.style.display = 'flex';
  chip.classList.remove('urgent', 'done');

  if (diffDays < 0) {
    daysEl.textContent  = '🎓 Exam Day Passed';
    labelEl.textContent = 'Hope it went well!';
    chip.classList.add('done');
  } else if (diffDays === 0) {
    daysEl.textContent  = '🔥 TODAY!';
    labelEl.textContent = 'Good luck on your board exam!';
    chip.classList.add('urgent');
  } else if (diffDays === 1) {
    daysEl.textContent  = '1 day';
    labelEl.textContent = 'Tomorrow is your board exam!';
    chip.classList.add('urgent');
  } else if (diffDays <= 7) {
    daysEl.textContent  = diffDays + ' days';
    labelEl.textContent = 'days to board exam';
    chip.classList.add('urgent');
  } else {
    daysEl.textContent  = diffDays + ' days';
    labelEl.textContent = 'days to board exam';
  }
}

// Refresh countdown every minute (in case browser stays open overnight)
setInterval(() => { if (currentUser) updateCountdown(); }, 60 * 1000);


// ══════════════════════════════════════════════════════════════
//  POMODORO TIMER
// ══════════════════════════════════════════════════════════════

const POM_MODES = {
  focus: { label: 'Stay focused for 25 minutes!', minutes: 25, color: 'var(--green)' },
  short: { label: 'Short break — relax for 5 minutes.', minutes: 5,  color: '#60a5fa' },
  long:  { label: 'Long break — rest for 15 minutes.',  minutes: 15, color: '#a78bfa' }
};
const CIRCUMFERENCE = 2 * Math.PI * 52; // r=52

let pomMode      = 'focus';
let pomRunning   = false;
let pomSeconds   = 25 * 60;
let pomTotal     = 25 * 60;
let pomInterval  = null;
let pomSession   = 1;
let pomCompleted = 0;   // completed focus sessions
let pomWidgetOpen = false;

function showPomodoroFab() {
  document.getElementById('pomodoroFab').style.display = 'flex';
}

function togglePomodoro() {
  pomWidgetOpen = !pomWidgetOpen;
  document.getElementById('pomodoroWidget').style.display = pomWidgetOpen ? 'block' : 'none';
}

function switchMode(mode) {
  // Don't switch if running
  if (pomRunning) { showToast('Pause the timer before switching modes'); return; }
  pomMode = mode;
  pomSeconds = POM_MODES[mode].minutes * 60;
  pomTotal   = pomSeconds;

  // Update tabs
  document.querySelectorAll('.pom-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${mode}`).classList.add('active');

  // Update ring color
  const ring = document.getElementById('pomRingProgress');
  ring.style.stroke = POM_MODES[mode].color;
  ring.classList.toggle('break-mode', mode !== 'focus');

  // Update play button color
  const playBtn = document.getElementById('pomPlayBtn');
  playBtn.classList.toggle('break-mode', mode !== 'focus');
  playBtn.style.background = POM_MODES[mode].color;

  // Update footer label
  document.getElementById('pomModeLabel').textContent = POM_MODES[mode].label;

  renderPomTimer();
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
  document.getElementById('pomPlayBtn').textContent = '⏸';
  document.getElementById('pomodoroFab').classList.toggle('running', pomMode === 'focus');
  document.getElementById('pomodoroFab').classList.toggle('break-running', pomMode !== 'focus');

  pomInterval = setInterval(() => {
    pomSeconds--;
    renderPomTimer();
    if (pomSeconds <= 0) {
      clearInterval(pomInterval);
      pomRunning = false;
      onPomComplete();
    }
  }, 1000);
}

function pausePomodoro() {
  pomRunning = false;
  clearInterval(pomInterval);
  document.getElementById('pomPlayBtn').textContent = '▶';
  document.getElementById('pomodoroFab').classList.remove('running', 'break-running');
}

function resetPomodoro() {
  pausePomodoro();
  pomSeconds = POM_MODES[pomMode].minutes * 60;
  pomTotal   = pomSeconds;
  renderPomTimer();
}

function skipPomodoro() {
  pausePomodoro();
  onPomComplete();
}

// ── Pomodoro Sound (Web Audio API — no files needed) ──────────
function playPomSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    const notes = type === 'focus_done'
      ? [523, 659, 784, 1047]   // C E G C — upbeat "done!" arpeggio
      : [523, 494, 440];         // C B A — gentle descending "break time"

    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type      = 'sine';
      osc.frequency.value = freq;

      const start = ctx.currentTime + i * 0.18;
      const end   = start + 0.22;

      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, end);

      osc.start(start);
      osc.stop(end);
    });
  } catch(e) { /* Audio not supported — silent fallback */ }
}

function onPomComplete() {
  document.getElementById('pomodoroFab').classList.remove('running', 'break-running');
  document.getElementById('pomPlayBtn').textContent = '▶';

  if (pomMode === 'focus') {
    pomCompleted++;
    pomSession = Math.min(pomSession + 1, 4);
    // Auto suggest break
    if (pomCompleted % 4 === 0) {
      showToast('🎉 4 sessions done! Take a long break!');
      switchMode('long');
    } else {
      showToast('✅ Focus session done! Take a short break.');
      switchMode('short');
    }
  } else {
    // Break done — back to focus
    showToast('⏰ Break over! Time to focus.');
    if (pomSession > 4) pomSession = 1;
    switchMode('focus');
  }

  // Play completion sound
  const soundType = (pomMode === 'focus') ? 'break_time' : 'focus_done';
  playPomSound(soundType);

  // Open widget so user sees the transition
  pomWidgetOpen = true;
  document.getElementById('pomodoroWidget').style.display = 'block';
  renderPomDots();

  // Browser notification if supported
  if (Notification.permission === 'granted') {
    new Notification('BoardPrep PH 🍅', {
      body: pomMode === 'focus' ? 'Break time! You earned it.' : 'Back to studying!',
      icon: '📚'
    });
  }
}

function renderPomTimer() {
  // Time display
  const m = Math.floor(pomSeconds / 60).toString().padStart(2, '0');
  const s = (pomSeconds % 60).toString().padStart(2, '0');
  document.getElementById('pomTime').textContent = `${m}:${s}`;

  // Ring progress
  const progress  = pomSeconds / pomTotal;
  const offset    = CIRCUMFERENCE * (1 - progress);
  document.getElementById('pomRingProgress').style.strokeDashoffset = offset;

  // Update page title when running
  if (pomRunning) {
    document.title = `${m}:${s} — BoardPrep PH`;
  } else {
    document.title = 'BoardPrep PH';
  }
}

function renderPomDots() {
  const dotsEl = document.getElementById('pomDots');
  document.getElementById('pomSession').textContent = Math.min(pomSession, 4);
  dotsEl.innerHTML = [1,2,3,4].map(i => {
    let cls = 'pom-dot';
    if (i < pomSession) cls += ' done';
    else if (i === pomSession) cls += ' current';
    return `<div class="${cls}"></div>`;
  }).join('');
}

// Request notification permission when user first interacts with pomodoro
document.getElementById('pomodoroFab').addEventListener('click', () => {
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}, { once: true });

// Init ring dasharray
document.getElementById('pomRingProgress').style.strokeDasharray = CIRCUMFERENCE;
renderPomDots();

// ══════════════════════════════════════════════════════════════
//  AI DAILY MOTIVATION  (Gemini API)
// ══════════════════════════════════════════════════════════════

const GEMINI_API_KEY = 'REPLACE_WITH_YOUR_GEMINI_KEY';  // ← replaced via env in production
const MOTIVATION_CACHE_KEY = () => `boardprep_motivation_${currentUser?.id || 'anon'}`;

const STUDY_TIPS = [
  "Use the Pomodoro technique — 25 minutes of focused study, then a 5-minute break. Repeat.",
  "Teach what you've just learned to an imaginary student. If you can explain it, you know it.",
  "Review your notes within 24 hours of studying to move info into long-term memory.",
  "Don't just re-read — practice active recall. Close your notes and write what you remember.",
  "Start with the hardest subject first when your mind is freshest.",
  "Group related topics together. Your brain loves patterns and connections.",
  "Sleep is when your brain consolidates memories. Never sacrifice sleep for cramming.",
  "Use mnemonics and acronyms for lists. Create stories around difficult concepts.",
  "Take practice exams under real conditions — same time limit, no distractions.",
  "Hydrate! Your brain is 75% water. Dehydration reduces focus and memory.",
  "Break big subjects into small chunks. One subsection at a time.",
  "Exercise boosts brain-derived neurotrophic factor (BDNF) — walk before a study session.",
  "Write by hand when memorizing. The physical act helps encode information.",
  "Eliminate your phone during focus sessions. Every notification breaks your flow.",
  "Celebrate small wins. Finished a subsection? That deserves a moment of pride.",
];

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

const PROFESSION_TIPS = {
  'Nursing': [
    "Use SBAR (Situation, Background, Assessment, Recommendation) to organize your clinical thinking.",
    "For drug calculations, always identify what you have, what you need, and what to calculate.",
    "Remember Maslow's hierarchy — physiological needs always come first in priority questions.",
    "When answering NLE questions, ask: what is the safest, most therapeutic nursing action?",
    "ABC (Airway, Breathing, Circulation) guides your priority among multiple patients.",
  ],
  'Engineering': [
    "Derive formulas from first principles so you understand when and why to apply them.",
    "In engineering board exams, always check units — wrong units mean wrong answers.",
    "Practice time management: don't spend more than 2 minutes on any single problem.",
    "Review past board exam problems — patterns repeat more than you think.",
  ],
  'CPA': [
    "For taxation, focus on the exceptions and special rules — those are what the exam tests.",
    "In auditing, always think from the auditor's perspective: what could go wrong?",
    "Financial accounting standards change — make sure your review materials are current.",
    "Practice mental math for quick computations — calculators aren't always faster.",
  ],
  'Law': [
    "Master the exceptions to rules — bar exams love to test edge cases.",
    "For each principle, know: the rule, the exception, and the exception to the exception.",
    "Read case digests, not just the full text — you need the principle, not every detail.",
    "Practice writing concise, structured answers: issue, rule, application, conclusion.",
  ],
  'Teachers': [
    "For LET, focus on child development theories — Piaget, Vygotsky, Erikson are always tested.",
    "Know the K-12 curriculum framework inside and out — it's the basis of many questions.",
    "Professional education questions test your judgment as a teacher, not just knowledge.",
    "For the general education component, review breadth over depth.",
  ],
};

function getRandomTip(profession) {
  // Find profession-specific tips
  const key = Object.keys(PROFESSION_TIPS).find(k => profession && profession.includes(k));
  const specificTips = key ? PROFESSION_TIPS[key] : [];
  // Mix: 40% chance of profession-specific tip if available
  const allTips = specificTips.length > 0 && Math.random() < 0.4
    ? specificTips
    : STUDY_TIPS;
  return allTips[Math.floor(Math.random() * allTips.length)];
}

async function fetchMotivation(forceRefresh = false) {
  const btn     = document.getElementById('motivationRefreshBtn');
  const loading = document.getElementById('motivationLoading');
  const msgEl   = document.getElementById('motivationMessage');
  const footer  = document.getElementById('motivationFooter');
  const dateEl  = document.getElementById('motivationDate');
  const tipEl   = document.getElementById('motivationTip');
  const tipText = document.getElementById('motivationTipText');

  if (!msgEl) return;  // not in tracker view

  const todayKey = getTodayKey();

  // Check cache — use stored message if same day and not forced
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(MOTIVATION_CACHE_KEY()) || 'null');
      if (cached && cached.date === todayKey && cached.message) {
        renderMotivation(cached.message, cached.tip, todayKey);
        return;
      }
    } catch(e) {}
  }

  // Show loading
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  if (loading) loading.style.display = 'block';
  if (msgEl)   msgEl.style.display   = 'none';
  if (footer)  footer.style.display  = 'none';
  if (tipEl)   tipEl.style.display   = 'none';

  // Build a deeply personalised prompt based on subjects + progress
  const { total, done } = subjects.reduce((acc, s) => {
    const p = subjectProgress(s);
    return { total: acc.total + p.total, done: acc.done + p.done };
  }, { total: 0, done: 0 });
  const pct      = total === 0 ? 0 : Math.round((done / total) * 100);
  const name     = currentUser?.display_name || 'reviewer';

  // Collect subject names for Gemini to read
  const subjectNames = subjects.map(s => s.name);

  // Detect likely profession from subject names
  const allSubText = subjectNames.join(' ').toLowerCase();
  let profession = 'board exam';
  if (/nurs|nclex|medic|surgical|pharma|anatomy|physiol|pediatr|obstet|maternal|psychiatric|community health/i.test(allSubText))
    profession = 'Nursing Licensure Exam (NLE)';
  else if (/civil|structural|hydraulic|geotechn|engineer|surveying|mathematics|physics|strength of materials/i.test(allSubText))
    profession = 'Engineering board exam';
  else if (/accountan|audit|taxation|financial|management accounting|business law|cpa/i.test(allSubText))
    profession = 'CPA board exam';
  else if (/architect|design|building|planning|history of arch/i.test(allSubText))
    profession = 'Architecture board exam';
  else if (/law|criminal|civil law|constitutional|legal|bar exam/i.test(allSubText))
    profession = 'Bar exam';
  else if (/medicine|anatomy|biochem|patholog|pharmacol|microbio|internal medicine|surgery/i.test(allSubText))
    profession = 'Medical board exam';
  else if (/dentist|oral|dental|periodont/i.test(allSubText))
    profession = 'Dentistry board exam';
  else if (/psycholog|mental health|counseling|psychopath/i.test(allSubText))
    profession = 'Psychology board exam';
  else if (/teacher|education|lept|professional education|social science/i.test(allSubText))
    profession = 'Licensure Exam for Teachers (LET)';
  else if (/physical therapy|pt |occupational therapy|rehabilitation/i.test(allSubText))
    profession = 'Physical Therapy/Occupational Therapy board exam';
  else if (/pharmacy|pharmacog|pharmaceutical|drug/i.test(allSubText))
    profession = 'Pharmacy board exam';
  else if (/veterinar|animal|zoology/i.test(allSubText))
    profession = 'Veterinary board exam';
  else if (/criminolog|crime|forensic/i.test(allSubText))
    profession = 'Criminology board exam';

  // Find weakest subject (lowest % done) to give targeted encouragement
  let weakestSubject = null;
  let weakestPct = 101;
  subjects.forEach(s => {
    const p = subjectProgress(s);
    const sp = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
    if (sp < weakestPct && p.total > 0) { weakestPct = sp; weakestSubject = s.name; }
  });

  // Find strongest subject (most progress)
  let strongestSubject = null;
  let strongestPct = -1;
  subjects.forEach(s => {
    const p = subjectProgress(s);
    const sp = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
    if (sp > strongestPct && p.total > 0) { strongestPct = sp; strongestSubject = s.name; }
  });

  const subjectContext = subjectNames.length > 0
    ? `Their subjects include: ${subjectNames.slice(0, 6).join(', ')}${subjectNames.length > 6 ? ', and more' : ''}.`
    : '';
  const weakContext = weakestSubject && weakestPct < 60
    ? `They are still working hard on ${weakestSubject} (${weakestPct}% done) — gently encourage them to tackle it.`
    : '';
  const strongContext = strongestSubject && strongestPct >= 70
    ? `They have made great progress on ${strongestSubject} (${strongestPct}% done) — acknowledge this strength.`
    : '';

  const prompt = `You are a warm, encouraging study coach for Filipino board exam reviewers.

Write a short daily motivational message (3-5 sentences, under 90 words) for ${name} who is preparing for the Philippine ${profession}.
${subjectContext}
They have completed ${pct}% of their overall review.
${pct === 0 ? "They are just beginning — welcome them and encourage the first step." : ""}
${pct > 0 && pct < 30 ? "They are in the early stages — encourage them to build momentum and consistency." : ""}
${pct >= 30 && pct < 60 ? "They are making solid progress — acknowledge the hard work and push them to keep going." : ""}
${pct >= 60 && pct < 85 ? "They are deep in the review — they can see the finish line, encourage the final push." : ""}
${pct >= 85 ? "They are almost done — fire them up, the board exam is within reach!" : ""}
${weakContext}
${strongContext}

Important rules:
- Speak directly to ${name} by name at least once
- Reference the specific profession (${profession}) naturally in the message
- Use one Tagalog or Filipino word/phrase that fits naturally (e.g. kaya mo, diskarte, malakas ang loob)
- Write in warm, flowing prose — NO bullet points, NO headers
- End with ONE short powerful sentence (under 15 words) that will stick all day
- Sound human and genuine, not like a template`;

  try {
    const key = window.__GEMINI_KEY__ || GEMINI_API_KEY;
    if (!key || key === 'REPLACE_WITH_YOUR_GEMINI_KEY') {
      // No key — show a profession-aware static fallback message
      const fallbacks = [
        `Kaya mo 'yan, ${name}! Every page you study for your ${profession} brings you one step closer to the life you are working toward. This journey is not easy, but it was never meant to be — because the people who pass are those who refused to quit. Maniwala ka sa sarili mo. Your future patients, clients, and community are counting on you.`,
        `Hindi madali ang daan, ${name}, but that is exactly why passing your ${profession} will mean so much. Today, show up for yourself and for every person who will one day benefit from your expertise. One topic at a time, one day at a time — that is how reviewers become licensed professionals. You are closer than you think!`,
        `Every hour you invest today studying for your ${profession} is interest earned on your future, ${name}. The person who passes is not the smartest — it is the one who never stopped showing up, even on the hard days. Ikaw 'yan. Believe it. Now open your book and let us get to work!`,
      ];
      const msg = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      const tip = getRandomTip(profession);
      cacheMotivation(msg, tip, todayKey);
      renderMotivation(msg, tip, todayKey);
      return;
    }

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 200, temperature: 0.9 }
        })
      }
    );

    if (!resp.ok) throw new Error(`Gemini error ${resp.status}`);

    const data    = await resp.json();
    const message = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!message) throw new Error('Empty response');

    const tip = getRandomTip(profession);
    cacheMotivation(message, tip, todayKey);
    renderMotivation(message, tip, todayKey);

  } catch(e) {
    console.warn('Motivation fetch failed:', e);
    // Graceful fallback
    const fallback = `You've got this, ${name}! Every great ${profession.replace(' board exam','').replace(' Exam','').replace(' (NLE)','')} professional started exactly where you are now — studying, pushing through, and choosing not to quit. Ang tagumpay ay hindi para sa pinakamatalino, kundi para sa pinaka-determinado. That's you. Keep going!`;
    const tip = getRandomTip(profession);
    renderMotivation(fallback, tip, todayKey);
  } finally {
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

function cacheMotivation(message, tip, dateKey) {
  try {
    localStorage.setItem(MOTIVATION_CACHE_KEY(), JSON.stringify({ date: dateKey, message, tip }));
  } catch(e) {}
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

  // Render message with simple formatting
  const formatted = message
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  msgEl.innerHTML = formatted;
  msgEl.style.display = 'block';

  // Footer
  if (footer) footer.style.display = 'flex';
  if (dateEl) {
    const [y, m, d] = dateKey.split('-');
    const date = new Date(y, m-1, d);
    dateEl.textContent = date.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  // Tip
  if (tip && tipText) {
    tipText.textContent = tip;
    if (tipEl) tipEl.style.display = 'block';
  }
}