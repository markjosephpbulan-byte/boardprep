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
async function loadProfiles() {
  const grid = document.getElementById('profilesGrid');
  grid.innerHTML = '<div class="loading-state">Loading profiles…</div>';
  try {
    const r = await fetch('/api/profiles');
    const profiles = await r.json();

    if (profiles.length === 0) {
      grid.innerHTML = `
        <div class="loading-state" style="grid-column:1/-1">
          <div style="font-size:2.5rem;margin-bottom:.75rem">👤</div>
          <div style="font-size:1rem;color:var(--text2)">No profiles yet.</div>
          <div style="font-size:.85rem;color:var(--text3);margin-top:4px">Be the first to create one!</div>
        </div>`;
      return;
    }

    grid.innerHTML = '';
    profiles.forEach(p => {
      const card = document.createElement('div');
      card.className = 'profile-card';
      card.onclick = () => openLoginForProfile(p);
      const avatarHTML = p.avatar
        ? `<img src="${p.avatar}" alt="${esc(p.display_name)}">`
        : `<span>${esc(p.display_name[0].toUpperCase())}</span>`;
      card.innerHTML = `
        <div class="profile-card-avatar">${avatarHTML}</div>
        <div class="profile-card-name">${esc(p.display_name)}</div>
        <div class="profile-card-username">@${esc(p.username)}</div>
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
  } catch(e) {
    grid.innerHTML = '<div class="loading-state">Failed to load profiles.</div>';
  }
}

// ══════════════════════════════════════════════════════════════
//  AUTH — Register
// ══════════════════════════════════════════════════════════════
async function doRegister() {
  const username     = document.getElementById('reg-username').value.trim();
  const display_name = document.getElementById('reg-display').value.trim();
  const password     = document.getElementById('reg-password').value;
  const errEl        = document.getElementById('reg-error');
  const btn          = document.getElementById('reg-btn');
  errEl.textContent  = '';

  // Basic client-side checks first
  if (!username)        { errEl.textContent = 'Please enter a username.'; return; }
  if (username.length < 3) { errEl.textContent = 'Username must be at least 3 characters.'; return; }
  if (!password)        { errEl.textContent = 'Please enter a password.'; return; }
  if (password.length < 4) { errEl.textContent = 'Password must be at least 4 characters.'; return; }

  // Show loading
  btn.textContent = 'Creating…';
  btn.disabled = true;

  try {
    const r = await fetch('/api/auth/register', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, display_name, password })
    });
    const data = await r.json();
    if (!r.ok) {
      errEl.textContent = data.error || 'Something went wrong. Please try again.';
      return;
    }
    currentUser = data;
    subjects = []; notes = [];
    await enterTracker();
  } catch(e) {
    errEl.textContent = 'Connection error. Please check your internet and try again.';
  } finally {
    btn.textContent = 'Create Profile';
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
  await fetch('/api/auth/logout', { method: 'POST' });
  currentUser = null; subjects = []; notes = [];
  closeProfileMenu();
  showView('landing');
  loadProfiles();
}

// ══════════════════════════════════════════════════════════════
//  TRACKER — Enter
// ══════════════════════════════════════════════════════════════
async function enterTracker() {
  updateHeaderProfile();
  showView('tracker');
  await Promise.all([loadSubjects(), loadNotes()]);
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
  document.getElementById('profileDisplayName').value = currentUser.display_name;
  document.getElementById('profileCurrentPw').value   = '';
  document.getElementById('profileNewPw').value       = '';
  document.getElementById('profile-error').textContent = '';
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

  // Update display name / password
  const body = { display_name: document.getElementById('profileDisplayName').value.trim() };
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
  closeModal('profileModal');
  showToast('Profile updated!');
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
function renderNotes() {
  const list  = document.getElementById('notesList');
  const badge = document.getElementById('notesBadge');
  badge.textContent = notes.length;
  if (!notes.length) {
    list.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text3);font-size:.85rem">No notes yet.<br>Click "+ New Note" to add one!</div>`;
    return;
  }
  list.innerHTML = notes.map(n => `
    <div class="note-card" style="background:${n.color}" onclick="openEditNoteModal('${n.id}')">
      <button class="note-card-del" onclick="event.stopPropagation(); confirmDelete('note','${n.id}')">✕</button>
      <div class="note-card-title">${esc(n.title)}</div>
      <div class="note-card-preview">${esc(n.content)}</div>
      <div class="note-card-meta">${formatDate(n.updated_at)}</div>
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