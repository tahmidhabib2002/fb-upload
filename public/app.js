/* ============================================================
   app.js — FB Bulk Scheduler Frontend Logic (Fixed)
   ============================================================ */

// ── STATE ─────────────────────────────────────────────────
const state = {
  pages: [],           // Connected pages from DB
  selectedPageIds: new Set(),
  files: [],           // { file, name, size, customTitle }
  activeBatchId: null,
  progressInterval: null,
  logsPage: 1,
  logsTotal: 0,
  logsStatusFilter: ''
};

// ── DOM HELPERS ───────────────────────────────────────────
const $ = id => document.getElementById(id);
const formatSize = bytes => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
};

// BST display (UTC+6)
const fmtBST = isoStr => {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  const bst = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  return bst.toISOString().replace('T', ' ').slice(0, 16) + ' BST';
};

const fmtDate = isoStr => {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  const bst = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  return bst.toLocaleDateString('en-BD', { month: 'short', day: 'numeric', year: 'numeric' }) + 
         ' ' + bst.toISOString().slice(11, 16) + ' BST';
};

// ── TOAST NOTIFICATIONS ───────────────────────────────────
function toast(msg, type = 'info', duration = 4000) {
  const icons = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || '•'}</span><span>${msg}</span>`;
  $('toastContainer').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 350);
  }, duration);
}

// ── API CALLS ─────────────────────────────────────────────
async function api(method, path, body, isFormData = false) {
  // Auto-detect API base URL (works for both localhost and production)
  const baseUrl = window.location.origin + '/api';
  
  const opts = {
    method,
    headers: isFormData ? {} : { 'Content-Type': 'application/json' }
  };
  if (body) opts.body = isFormData ? body : JSON.stringify(body);
  
  const res = await fetch(baseUrl + path, opts);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = { error: 'Server returned an invalid response' };
  }
  
  // Handle 401 Unauthorized
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired. Redirecting to login...');
  }
  
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── NAVIGATION ────────────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = $(`section-${name}`);
  if (sec) sec.classList.add('active');
  const nav = document.querySelector(`[data-section="${name}"]`);
  if (nav) nav.classList.add('active');
  $('sidebar')?.classList.remove('open');
  $('sidebarOverlay')?.classList.remove('open');
  if (name === 'logs') loadLogs();
  if (name === 'pages') loadConnectedPages();
  if (name === 'upload') loadPagesChecklist();
}

// ── PAGES CHECKLIST (with fixed single selection) ─────────
async function loadPages() {
  try {
    const data = await api('GET', '/pages');
    state.pages = data.pages || [];
    return state.pages;
  } catch (e) {
    toast('Failed to load pages: ' + e.message, 'error');
    return [];
  }
}

async function loadPagesChecklist() {
  const pages = await loadPages();
  const checklistEl = $('pagesChecklist');
  if (!checklistEl) return;

  if (pages.length === 0) {
    checklistEl.innerHTML = `
      <div class="empty-state">
        <span>No pages connected yet.</span>
        <button class="link-btn" data-goto="connect">Connect pages →</button>
      </div>
    `;
    $('pageSelectActions').style.display = 'none';
    return;
  }

  checklistEl.innerHTML = pages.map(p => `
    <label class="page-checkbox">
      <input type="checkbox" value="${p.page_id}" data-name="${p.page_name}" />
      <span class="checkbox-visual"></span>
      <span class="page-label">
        ${p.picture_url ? `<img src="${p.picture_url}" alt="" />` : ''}
        <div>
          <strong>${p.page_name}</strong>
          <small>${p.page_id}</small>
        </div>
      </span>
    </label>
  `).join('');

  const actionBtn = $('pageSelectActions');
  if (actionBtn) actionBtn.style.display = 'flex';

  // Checkboxes: update state & buttons
  checklistEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = checklistEl.querySelectorAll('input[type="checkbox"]:checked');
      state.selectedPageIds.clear();
      checked.forEach(c => state.selectedPageIds.add(c.value));
      updatePageSelectButtons();
      updateSubmitSummary();
    });
  });
}

function updatePageSelectButtons() {
  const all = document.querySelectorAll('#pagesChecklist input[type="checkbox"]').length;
  const checked = state.selectedPageIds.size;
  const countEl = $('selectedCount');
  if (countEl) {
    countEl.textContent = checked === 0 ? 'None selected' : `${checked} selected`;
    if (checked === all && all > 0) countEl.textContent += ' (all)';
  }
}

function selectAllPages() {
  const checklistEl = $('pagesChecklist');
  checklistEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = true;
    state.selectedPageIds.add(cb.value);
  });
  updatePageSelectButtons();
  updateSubmitSummary();
}

function deselectAllPages() {
  const checklistEl = $('pagesChecklist');
  checklistEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
  });
  state.selectedPageIds.clear();
  updatePageSelectButtons();
  updateSubmitSummary();
}

// ── PAGES GRID (connected pages display) ────────────────
async function loadConnectedPages() {
  try {
    const pages = await loadPages();
    const grid = $('connectedPagesGrid');
    if (!grid) return;

    if (pages.length === 0) {
      grid.innerHTML = '<div class="empty-state">No pages connected yet.</div>';
      return;
    }

    grid.innerHTML = pages.map(p => `
      <div class="page-card">
        ${p.picture_url ? `<img src="${p.picture_url}" alt="" class="page-card-img" />` : '<div class="page-card-img-placeholder">📄</div>'}
        <div class="page-card-body">
          <strong>${p.page_name}</strong>
          <small>${p.page_id}</small>
          ${p.category ? `<span class="badge-neutral">${p.category}</span>` : ''}
        </div>
      </div>
    `).join('');
  } catch (e) {
    toast('Failed to load pages: ' + e.message, 'error');
    const grid = $('connectedPagesGrid');
    if (grid) grid.innerHTML = '<div class="empty-state error">Failed to load pages</div>';
  }
}

// ── FILES DROP ZONE ────────────────────────────────────────
const dropZone = $('dropZone');
if (dropZone) {
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
  });
}

const fileInput = $('fileInput');
if (fileInput) {
  fileInput.addEventListener('change', e => {
    const files = Array.from(e.target.files);
    addFiles(files);
  });
}

function addFiles(files) {
  const videoFiles = files.filter(f => f.type.startsWith('video/'));
  
  if (videoFiles.length === 0) {
    toast('Please drop video files only', 'warning');
    return;
  }

  if (state.files.length + videoFiles.length > 100) {
    toast('Maximum 100 files. You have ' + (100 - state.files.length) + ' slots left.', 'warning');
    videoFiles.splice(100 - state.files.length);
  }

  videoFiles.forEach(file => {
    state.files.push({
      file,
      name: file.name,
      size: file.size,
      customTitle: null
    });
  });

  renderFileList();
  updateSubmitSummary();
}

function renderFileList() {
  const listWrap = $('fileListWrap');
  const fileList = $('fileList');
  const fileCountBadge = $('fileCountBadge');

  if (!listWrap || !fileList) return;

  if (state.files.length === 0) {
    listWrap.style.display = 'none';
    return;
  }

  listWrap.style.display = 'block';
  fileCountBadge.textContent = state.files.length + ' files';

  fileList.innerHTML = state.files.map((f, i) => `
    <div class="file-item">
      <span class="file-item-name">${escHtml(f.name)}</span>
      <span class="file-item-size">${formatSize(f.size)}</span>
      <input type="text" class="file-item-title form-input" placeholder="Override title (optional)" value="${f.customTitle || ''}" data-index="${i}" />
      <button class="btn-icon" onclick="removeFile(${i})" title="Remove">✕</button>
    </div>
  `).join('');

  // Title override handlers
  fileList.querySelectorAll('.file-item-title').forEach(input => {
    input.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.index);
      state.files[idx].customTitle = e.target.value.trim() || null;
      updateSubmitSummary();
    });
  });
}

function removeFile(idx) {
  state.files.splice(idx, 1);
  renderFileList();
  updateSubmitSummary();
}

window.removeFile = removeFile;

// ── SCHEDULE PREVIEW ────────────────────────────────────────
function updateSchedulePreview() {
  const startDateVal = $('startDate')?.value;
  const postTimeVal = $('postTime')?.value;
  const preview = $('previewList');

  if (!startDateVal || !postTimeVal) return;

  const previewWrap = $('schedulePreview');
  if (!previewWrap) return;
  previewWrap.style.display = 'block';

  const dateTime = new Date(`${startDateVal}T${postTimeVal}`);
  const items = [];

  for (let i = 0; i < state.files.length; i++) {
    const postTime = new Date(dateTime.getTime() + i * 24 * 60 * 60 * 1000);
    items.push(`
      <div class="preview-item">
        <strong>#${i + 1}</strong>
        <span>${postTime.toLocaleDateString('en-BD')} @ ${postTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })} BST</span>
        <small>${state.files[i].customTitle || state.files[i].name}</small>
      </div>
    `);
  }

  if (preview) preview.innerHTML = items.join('');
}

// ── SUBMIT SUMMARY ──────────────────────────────────────────
function updateSubmitSummary() {
  const videoCnt = state.files.length;
  const pageCnt = state.selectedPageIds.size;
  const totalCnt = videoCnt * pageCnt;

  const infoPillVideos = $('infoPillVideos');
  const infoPillPages = $('infoPillPages');
  const infoPillTotal = $('infoPillTotal');
  const submitBtn = $('submitBtn');

  if (infoPillVideos) infoPillVideos.textContent = videoCnt + ' video' + (videoCnt !== 1 ? 's' : '');
  if (infoPillPages) infoPillPages.textContent = pageCnt + ' page' + (pageCnt !== 1 ? 's' : '');
  if (infoPillTotal) infoPillTotal.textContent = totalCnt + ' total upload' + (totalCnt !== 1 ? 's' : '');

  if (submitBtn) {
    submitBtn.disabled = videoCnt === 0 || pageCnt === 0;
  }
}

// ── SUBMIT BULK UPLOAD ──────────────────────────────────────
const submitBtn = $('submitBtn');
if (submitBtn) {
  submitBtn.addEventListener('click', async () => {
    const startDateVal = $('startDate')?.value;
    const postTimeVal = $('postTime')?.value;

    if (!startDateVal || !postTimeVal) {
      toast('Please set Start Date and Post Time', 'warning');
      return;
    }

    const uploads = [];
    const baseDateTime = new Date(`${startDateVal}T${postTimeVal}`);

    for (let i = 0; i < state.files.length; i++) {
      const postTime = new Date(baseDateTime.getTime() + i * 24 * 60 * 60 * 1000);
      const expireTime = new Date(postTime.getTime() + 7 * 24 * 60 * 60 * 1000);

      for (const pageId of state.selectedPageIds) {
        uploads.push({
          file: state.files[i].file,
          pageId,
          title: state.files[i].customTitle || state.files[i].name,
          description: $('masterDesc')?.value || '',
          scheduledTime: postTime.toISOString(),
          expireTime: expireTime.toISOString()
        });
      }
    }

    state.activeBatchId = 'batch_' + Date.now();
    showProgressModal();

    for (const upload of uploads) {
      await uploadQueue.add(() => uploadVideoFile(upload));
    }
  });
}

// Upload queue
const uploadQueue = {
  queue: [],
  add: async (fn) => {
    await new Promise(resolve => {
      uploadQueue.queue.push(async () => {
        await fn();
        resolve();
      });
      processQueue();
    });
  }
};

async function processQueue() {
  if (uploadQueue.processing) return;
  uploadQueue.processing = true;

  while (uploadQueue.queue.length > 0) {
    const fn = uploadQueue.queue.shift();
    try {
      await fn();
    } catch (e) {
      console.error('Upload error:', e);
    }
  }

  uploadQueue.processing = false;
}

async function uploadVideoFile(upload) {
  const { file, pageId, title, description, scheduledTime, expireTime } = upload;

  try {
    const formData = new FormData();
    formData.append('videos', file);
    formData.append('pageIds', JSON.stringify([pageId]));
    formData.append('title', title);
    formData.append('description', description);
    formData.append('scheduledTime', scheduledTime);
    formData.append('expireTime', expireTime);

    const res = await fetch(window.location.origin + '/api/upload/bulk', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Upload failed');
    }

    toast(`✓ Uploaded ${title}`, 'success');
    updateProgressModal(1, 0);
  } catch (e) {
    toast(`✗ Failed: ${e.message}`, 'error');
    updateProgressModal(0, 1);
  }
}

// ── PROGRESS MODAL ──────────────────────────────────────────
let progressState = { done: 0, failed: 0 };

function showProgressModal() {
  const overlay = $('progressOverlay');
  if (overlay) overlay.style.display = 'flex';
  progressState = { done: 0, failed: 0 };
  updateProgressModal(0, 0);
}

function updateProgressModal(done, failed) {
  progressState.done += done;
  progressState.failed += failed;
  const total = state.files.length * state.selectedPageIds.size;
  const completed = progressState.done + progressState.failed;

  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const progressFill = $('progressFill');
  if (progressFill) progressFill.style.width = pct + '%';

  const progressPct = $('progressPct');
  if (progressPct) progressPct.textContent = pct + '%';

  const progressDone = $('progressDone');
  if (progressDone) progressDone.textContent = progressState.done + ' done';

  const progressFailed = $('progressFailed');
  if (progressFailed) progressFailed.textContent = progressState.failed + ' failed';

  const progressLeft = $('progressLeft');
  if (progressLeft) progressLeft.textContent = (total - completed) + ' queued';

  if (completed === total) {
    const closeBtn = $('progressClose');
    if (closeBtn) closeBtn.style.display = 'inline-block';
  }
}

// ── LOGS ────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const result = await api('GET', `/logs?page=${state.logsPage}&status=${state.logsStatusFilter}`);
    const tbody = $('logsBody');
    const logs = result.logs || [];

    if (tbody) {
      if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No logs found</td></tr>';
      } else {
        tbody.innerHTML = logs.map(log => `
          <tr>
            <td>${escHtml(log.video_title || 'Untitled')}</td>
            <td>${log.page_name || log.page_id}</td>
            <td>${fmtBST(log.scheduled_time)}</td>
            <td>${fmtBST(log.expire_time)}</td>
            <td><span class="status-badge ${log.status}">${log.status}</span></td>
            <td><button class="link-btn">View</button></td>
          </tr>
        `).join('');
      }
    }

    // Update stats
    if (result.stats) {
      $('statTotal').textContent = result.stats.total || '—';
      $('statScheduled').textContent = result.stats.scheduled || '—';
      $('statPending').textContent = result.stats.pending || '—';
      $('statFailed').textContent = result.stats.failed || '—';
    }

    // Update pagination
    state.logsTotal = result.total || 0;
    renderLogsPagination();
  } catch (e) {
    toast('Failed to load logs: ' + e.message, 'error');
  }
}

function renderLogsPagination() {
  const paginationEl = $('logsPagination');
  if (!paginationEl) return;

  const limit = 50;
  const totalPages = Math.ceil(state.logsTotal / limit);

  if (totalPages <= 1) {
    paginationEl.innerHTML = '';
    return;
  }

  let html = '';
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="btn-ghost btn-sm ${i === state.logsPage ? 'active' : ''}" onclick="state.logsPage = ${i}; loadLogs();">${i}</button>`;
  }

  paginationEl.innerHTML = html;
}

// ── CONNECT PAGES ─────────────────────────────────────────
const connectBtn = $('connectBtn');
if (connectBtn) {
  connectBtn.addEventListener('click', async () => {
    const token = $('userTokenInput')?.value.trim();
    if (!token) { toast('Please paste your User Access Token', 'error'); return; }

    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    const resultDiv = $('connectResult');
    if (resultDiv) resultDiv.style.display = 'none';

    try {
      const result = await api('POST', '/auth/connect', { userToken: token });
      if (resultDiv) {
        resultDiv.className = 'connect-result success';
        resultDiv.textContent = `✓ ${result.message}`;
        resultDiv.style.display = 'block';
      }
      toast(result.message, 'success');
      if ($('userTokenInput')) $('userTokenInput').value = '';
      loadPagesChecklist();
      loadConnectedPages();
    } catch (e) {
      if (resultDiv) {
        resultDiv.className = 'connect-result error';
        resultDiv.textContent = `✗ ${e.message}`;
        resultDiv.style.display = 'block';
      }
      toast('Connection failed: ' + e.message, 'error');
    } finally {
      connectBtn.disabled = false;
      connectBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      Connect & Import Pages`;
    }
  });
}

// ── MASTER TITLE / DATE / TIME LISTENERS ──────────────────
const masterTitleInput = $('masterTitle');
if (masterTitleInput) masterTitleInput.addEventListener('input', updateSchedulePreview);
const startDateInput = $('startDate');
if (startDateInput) startDateInput.addEventListener('change', () => { updateSchedulePreview(); updateSubmitSummary(); });
const postTimeInput = $('postTime');
if (postTimeInput) postTimeInput.addEventListener('change', () => { updateSchedulePreview(); updateSubmitSummary(); });

// ── NAVIGATION EVENT BINDING ──────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showSection(btn.dataset.section));
});
document.querySelectorAll('[data-goto]').forEach(btn => {
  btn.addEventListener('click', () => showSection(btn.dataset.goto));
});

// Mobile sidebar
const mobileMenuBtn = $('mobileMenuBtn');
const sidebar = $('sidebar');
const sidebarOverlay = $('sidebarOverlay');
if (mobileMenuBtn && sidebar && sidebarOverlay) {
  mobileMenuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('open');
  });
  sidebarOverlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('open');
  });
}

// ── ESCAPE HTML ───────────────────────────────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── INIT ──────────────────────────────────────────────────
(async function init() {
  await loadPagesChecklist();
  updateSubmitSummary();
})();

// Expose global functions that may be called from HTML
window.selectAllPages = selectAllPages;
window.deselectAllPages = deselectAllPages;
