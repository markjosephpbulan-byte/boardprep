/* ══════════════════════════════════════════════════════════════
   BoardPrep PH — Frontend JS  (Optimistic UI, no flicker)
   ══════════════════════════════════════════════════════════════ */

const API = '';

const SUBJECT_COLORS = ['#4f8ef7','#a78bfa','#34d399','#f97316','#f43f5e','#06b6d4','#eab308','#8b5cf6','#e879f9','#2dd4bf'];
const NOTE_COLORS    = ['#fef08a','#bbf7d0','#bfdbfe','#fecaca','#e9d5ff','#fed7aa','#d1fae5','#fce7f3'];

let subjects = [];
let notes    = [];
let ctx      = {};

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
async function init() {
  await Promise.all([loadSubjects(), loadNotes()]);
  buildColorPickers();
}

async function loadSubjects() {
  try {
    const r = await fetch(`${API}/api/subjects`);
    subjects = await r.json();
    renderSubjectsGrid();
    renderProgressOverview();
  } catch(e) { console.error(e); }
}

async function loadNotes() {
  try {
    const r = await fetch(`${API}/api/notes`);
    notes = await r.json();
    renderNotes();
  } catch(e) { console.error(e); }
}

// ══════════════════════════════════════════════════════════════
//  FULL GRID RENDER  (only called on page load / add / delete)
// ══════════════════════════════════════════════════════════════
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
        <input class="inline-input" id="ss-input-${subject.id}" placeholder="Add sub-subject..."
               onkeydown="handleSSEnter(event,'${subject.id}')" />
        <button class="btn-add-inline" onclick="quickAddSubsection('${subject.id}')">+ Add</button>
      </div>
    </div>`;
  return card;
}

function buildSubsectionHTML(subjectId, ss) {
  const topicTotal = ss.topics.length;
  const topicDone  = ss.topics.filter(t => t.done).length;
  const pct        = topicTotal === 0 ? (ss.done ? 100 : 0) : Math.round((topicDone / topicTotal) * 100);
  const cbClass    = ss.done ? 'checked' : (topicDone > 0 ? 'partial' : '');
  const checkMark  = ss.done ? '✓' : (topicDone > 0 ? '–' : '');

  return `
  <div class="subsection-item" id="ss-${ss.id}">
    <div class="subsection-header" onclick="toggleSubsection('${ss.id}')">
      <div class="custom-checkbox ${cbClass}" id="ss-cb-${ss.id}"
           onclick="event.stopPropagation(); toggleSubsectionDone('${subjectId}','${ss.id}')">${checkMark}</div>
      <span class="subsection-name ${ss.done ? 'done-text' : ''}" id="ss-name-${ss.id}">${esc(ss.name)}</span>
      <span class="subsection-sub-pct" id="ss-pct-${ss.id}">${pct}%</span>
      <div class="sub-actions">
        <button class="btn-icon" title="Delete sub-subject"
                onclick="event.stopPropagation(); confirmDelete('subsection','${subjectId}','${ss.id}')">🗑️</button>
      </div>
      <span class="subsection-toggle" id="sst-${ss.id}">▼</span>
    </div>
    <div class="subsection-body" id="ssb-${ss.id}" style="display:none">
      <div id="topic-list-${ss.id}">
        ${ss.topics.map(t => buildTopicHTML(subjectId, ss.id, t)).join('')}
      </div>
      <div class="add-topic-row">
        <input class="inline-input" id="t-input-${ss.id}" placeholder="Add topic..."
               onkeydown="handleTopicEnter(event,'${subjectId}','${ss.id}')" />
        <button class="btn-add-inline" onclick="quickAddTopic('${subjectId}','${ss.id}')">+ Add</button>
      </div>
    </div>
  </div>`;
}

function buildTopicHTML(subjectId, ssId, t) {
  return `
  <div class="topic-item" id="t-${t.id}">
    <div class="topic-checkbox ${t.done ? 'checked' : ''}" id="t-cb-${t.id}"
         onclick="toggleTopicDone('${subjectId}','${ssId}','${t.id}')">${t.done ? '✓' : ''}</div>
    <span class="topic-name ${t.done ? 'done-text' : ''}" id="t-name-${t.id}">${esc(t.name)}</span>
    <button class="btn-icon"
            onclick="confirmDelete('topic','${subjectId}','${ssId}','${t.id}')">🗑️</button>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
//  PROGRESS  (targeted DOM updates only)
// ══════════════════════════════════════════════════════════════
function subjectProgress(s) {
  let total = 0, done = 0;
  s.subsections.forEach(ss => {
    if (ss.topics.length === 0) { total += 1; if (ss.done) done += 1; }
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
      <span style="font-size:0.78rem; color:var(--text2)">${esc(s.name)}</span>
      <div class="chip-bar-wrap">
        <div class="chip-bar-fill" id="chip-bar-${s.id}" style="background:${s.color}; width:${pct}%"></div>
      </div>
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
  const overallPct = totalAll === 0 ? 0 : Math.round((doneAll / totalAll) * 100);
  document.getElementById('overallFill').style.width = overallPct + '%';
  document.getElementById('overallPct').textContent  = overallPct + '%';
}

// ══════════════════════════════════════════════════════════════
//  SUBJECT CRUD
// ══════════════════════════════════════════════════════════════
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
    const r = await fetch(`${API}/api/subjects`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, color })
    });
    const s = await r.json();
    subjects.push(s);
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('subjectsGrid').appendChild(buildSubjectCard(s));
    // Add chip
    const strip = document.getElementById('subjectProgressStrip');
    const chip  = document.createElement('div');
    chip.className = 'subject-chip';
    chip.id = `chip-${s.id}`;
    chip.innerHTML = `
      <div class="chip-dot" style="background:${s.color}"></div>
      <span style="font-size:0.78rem; color:var(--text2)">${esc(s.name)}</span>
      <div class="chip-bar-wrap">
        <div class="chip-bar-fill" id="chip-bar-${s.id}" style="background:${s.color}; width:0%"></div>
      </div>
      <span class="chip-pct" id="chip-pct-${s.id}" style="color:${s.color}">0%</span>`;
    strip.appendChild(chip);
    showToast('Subject added!');
  } else {
    await fetch(`${API}/api/subjects/${ctx.id}`, {
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
    const dot = document.querySelector(`#chip-${ctx.id} .chip-dot`);
    const lbl = document.querySelector(`#chip-${ctx.id} span`);
    const cb  = document.getElementById(`chip-bar-${ctx.id}`);
    const cp  = document.getElementById(`chip-pct-${ctx.id}`);
    if (dot) dot.style.background = color;
    if (cb)  cb.style.background  = color;
    if (cp)  cp.style.color       = color;
    if (lbl) lbl.textContent      = name;
    showToast('Subject updated!');
  }
  closeModal('subjectModal');
}

// ══════════════════════════════════════════════════════════════
//  SUBSECTION CRUD
// ══════════════════════════════════════════════════════════════
async function quickAddSubsection(subjectId) {
  const input = document.getElementById(`ss-input-${subjectId}`);
  const name  = input.value.trim();
  if (!name) return;
  const r  = await fetch(`${API}/api/subjects/${subjectId}/subsections`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name })
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

function handleSSEnter(e, subjectId) {
  if (e.key === 'Enter') quickAddSubsection(subjectId);
}

async function toggleSubsectionDone(subjectId, ssId) {
  const s  = subjects.find(x => x.id === subjectId);
  const ss = s?.subsections.find(x => x.id === ssId);
  if (!ss) return;

  // Flip state instantly (optimistic)
  ss.done = !ss.done;

  const cb    = document.getElementById(`ss-cb-${ssId}`);
  const name  = document.getElementById(`ss-name-${ssId}`);
  const pctEl = document.getElementById(`ss-pct-${ssId}`);

  if (cb) {
    cb.className   = 'custom-checkbox' + (ss.done ? ' checked' : '');
    cb.textContent = ss.done ? '✓' : '';
  }
  if (name) name.className = 'subsection-name' + (ss.done ? ' done-text' : '');

  const topicDone  = ss.topics.filter(t => t.done).length;
  const topicTotal = ss.topics.length;
  const pct = topicTotal === 0 ? (ss.done ? 100 : 0) : Math.round((topicDone / topicTotal) * 100);
  if (pctEl) pctEl.textContent = pct + '%';

  refreshCardProgress(subjectId);

  // API in background — no await needed for optimistic pattern
  fetch(`${API}/api/subjects/${subjectId}/subsections/${ssId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ done: ss.done })
  });
}

// ══════════════════════════════════════════════════════════════
//  TOPICS CRUD
// ══════════════════════════════════════════════════════════════
async function quickAddTopic(subjectId, ssId) {
  const input = document.getElementById(`t-input-${ssId}`);
  const name  = input.value.trim();
  if (!name) return;
  const r = await fetch(`${API}/api/subjects/${subjectId}/subsections/${ssId}/topics`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name })
  });
  const t = await r.json();
  const s  = subjects.find(x => x.id === subjectId);
  const ss = s?.subsections.find(x => x.id === ssId);
  if (ss) ss.topics.push(t);
  const list = document.getElementById(`topic-list-${ssId}`);
  if (list) list.insertAdjacentHTML('beforeend', buildTopicHTML(subjectId, ssId, t));
  // Keep subsection open
  const body   = document.getElementById(`ssb-${ssId}`);
  const toggle = document.getElementById(`sst-${ssId}`);
  if (body)   body.style.display = 'block';
  if (toggle) toggle.classList.add('open');
  // Update sub-pct
  const pctEl = document.getElementById(`ss-pct-${ssId}`);
  if (pctEl && ss) {
    const done  = ss.topics.filter(tp => tp.done).length;
    const total = ss.topics.length;
    pctEl.textContent = Math.round((done / total) * 100) + '%';
  }
  input.value = '';
  refreshCardProgress(subjectId);
  showToast('Topic added!');
}

function handleTopicEnter(e, subjectId, ssId) {
  if (e.key === 'Enter') quickAddTopic(subjectId, ssId);
}

async function toggleTopicDone(subjectId, ssId, topicId) {
  const s  = subjects.find(x => x.id === subjectId);
  const ss = s?.subsections.find(x => x.id === ssId);
  const t  = ss?.topics.find(x => x.id === topicId);
  if (!t) return;

  // Flip state instantly (optimistic)
  t.done = !t.done;

  const cb   = document.getElementById(`t-cb-${topicId}`);
  const name = document.getElementById(`t-name-${topicId}`);
  if (cb)   { cb.className = 'topic-checkbox' + (t.done ? ' checked' : ''); cb.textContent = t.done ? '✓' : ''; }
  if (name) name.className = 'topic-name' + (t.done ? ' done-text' : '');

  // Recalc subsection state
  const topicDone  = ss.topics.filter(tp => tp.done).length;
  const topicTotal = ss.topics.length;
  const subPct     = Math.round((topicDone / topicTotal) * 100);

  const ssCb   = document.getElementById(`ss-cb-${ssId}`);
  const ssPct  = document.getElementById(`ss-pct-${ssId}`);
  const ssName = document.getElementById(`ss-name-${ssId}`);

  if (ssPct) ssPct.textContent = subPct + '%';

  if (topicDone === topicTotal && topicTotal > 0) {
    ss.done = true;
    if (ssCb)   { ssCb.className = 'custom-checkbox checked'; ssCb.textContent = '✓'; }
    if (ssName) ssName.className = 'subsection-name done-text';
  } else if (topicDone === 0) {
    ss.done = false;
    if (ssCb)   { ssCb.className = 'custom-checkbox'; ssCb.textContent = ''; }
    if (ssName) ssName.className = 'subsection-name';
  } else {
    ss.done = false;
    if (ssCb)   { ssCb.className = 'custom-checkbox partial'; ssCb.textContent = '–'; }
    if (ssName) ssName.className = 'subsection-name';
  }

  refreshCardProgress(subjectId);

  // API in background
  fetch(`${API}/api/subjects/${subjectId}/subsections/${ssId}/topics/${topicId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ done: t.done })
  });
}

// ══════════════════════════════════════════════════════════════
//  NOTES CRUD
// ══════════════════════════════════════════════════════════════
function renderNotes() {
  const list  = document.getElementById('notesList');
  const badge = document.getElementById('notesBadge');
  badge.textContent = notes.length;
  if (notes.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text3);font-size:0.85rem;">No notes yet.<br>Click "+ New Note" to add one!</div>`;
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
    const r = await fetch(`${API}/api/notes`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ title, content, color })
    });
    const n = await r.json();
    notes.unshift(n);
    showToast('Note saved!');
  } else {
    await fetch(`${API}/api/notes/${ctx.id}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ title, content, color })
    });
    const idx = notes.findIndex(x => x.id === ctx.id);
    if (idx !== -1) {
      notes[idx].title = title; notes[idx].content = content;
      notes[idx].color = color; notes[idx].updated_at = new Date().toISOString();
    }
    showToast('Note updated!');
  }
  closeModal('noteModal');
  renderNotes();
}

// ══════════════════════════════════════════════════════════════
//  DELETE
// ══════════════════════════════════════════════════════════════
function confirmDelete(type, ...ids) {
  const messages = {
    subject:    'Delete this subject and ALL its sub-subjects and topics?',
    subsection: 'Delete this sub-subject and all its topics?',
    topic:      'Delete this topic?',
    note:       'Delete this note?'
  };
  document.getElementById('confirmMessage').textContent = messages[type];
  document.getElementById('confirmDeleteBtn').onclick = () => executeDelete(type, ...ids);
  openModal('confirmModal');
}

async function executeDelete(type, ...ids) {
  closeModal('confirmModal');
  if (type === 'subject') {
    const [subjectId] = ids;
    await fetch(`${API}/api/subjects/${subjectId}`, { method: 'DELETE' });
    subjects = subjects.filter(x => x.id !== subjectId);
    document.getElementById(`subject-${subjectId}`)?.remove();
    document.getElementById(`chip-${subjectId}`)?.remove();
    if (subjects.length === 0) {
      const grid  = document.getElementById('subjectsGrid');
      const empty = document.getElementById('emptyState');
      grid.appendChild(empty);
      empty.style.display = 'block';
    }
    refreshOverallProgress();
    showToast('Subject deleted');
  } else if (type === 'subsection') {
    const [subjectId, ssId] = ids;
    await fetch(`${API}/api/subjects/${subjectId}/subsections/${ssId}`, { method: 'DELETE' });
    const s = subjects.find(x => x.id === subjectId);
    if (s) s.subsections = s.subsections.filter(x => x.id !== ssId);
    document.getElementById(`ss-${ssId}`)?.remove();
    refreshCardProgress(subjectId);
    showToast('Sub-subject deleted');
  } else if (type === 'topic') {
    const [subjectId, ssId, topicId] = ids;
    await fetch(`${API}/api/subjects/${subjectId}/subsections/${ssId}/topics/${topicId}`, { method: 'DELETE' });
    const s  = subjects.find(x => x.id === subjectId);
    const ss = s?.subsections.find(x => x.id === ssId);
    if (ss) ss.topics = ss.topics.filter(x => x.id !== topicId);
    document.getElementById(`t-${topicId}`)?.remove();
    if (ss) {
      const done  = ss.topics.filter(t => t.done).length;
      const total = ss.topics.length;
      const pctEl = document.getElementById(`ss-pct-${ssId}`);
      if (pctEl) pctEl.textContent = (total === 0 ? 0 : Math.round((done / total) * 100)) + '%';
    }
    refreshCardProgress(subjectId);
    showToast('Topic deleted');
  } else if (type === 'note') {
    await fetch(`${API}/api/notes/${ids[0]}`, { method: 'DELETE' });
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
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-PH', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
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
    sw.style.background = c;
    sw.dataset.color = c;
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
    ['subjectModal','subsectionModal','topicModal','noteModal','confirmModal'].forEach(closeModal);
    const sidebar = document.getElementById('notesSidebar');
    if (sidebar.classList.contains('open')) toggleNotesSidebar();
  }
});

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) backdrop.classList.remove('open');
  });
});

// ══════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════
init();