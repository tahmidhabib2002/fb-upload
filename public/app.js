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
  // Use your actual backend URL
  const baseUrl = 'https://fb-upload-ruk6.onrender.com/api';
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
  await loadPages();
  const container = $('pagesChecklist');
  const actions = $('pageSelectActions');

  if (!state.pages.length) {
    container.innerHTML = `<div class="empty-state"><span>No pages connected yet.</span><button class="link-btn" onclick="showSection('connect')">Connect pages →</button></div>`;
    if (actions) actions.style.display = 'none';
    return;
  }

  container.innerHTML = state.pages.map(page => {
    const initials = page.page_name.slice(0, 2).toUpperCase();
    const picHtml = page.picture_url
      ? `<img src="${page.picture_url}" alt="" onerror="this.style.display='none'" />${initials}`
      : initials;

    return `
    <div class="page-check-item ${state.selectedPageIds.has(page.page_id) ? 'selected' : ''}"
         data-page-id="${page.page_id}">
      <input type="checkbox" value="${page.page_id}" style="pointer-events: none;"
             ${state.selectedPageIds.has(page.page_id) ? 'checked' : ''} />
      <div class="page-check-icon">${picHtml}</div>
      <span class="page-check-name">${page.page_name}</span>
      <div class="page-check-tick"></div>
    </div>`;
  }).join('');

  if (actions) actions.style.display = 'flex';
  updateSelectedCount();

  // Use event delegation on container – cleaner and avoids duplicate listeners
  container.onclick = (e) => {
    const item = e.target.closest('.page-check-item');
    if (!item) return;
    const pid = item.dataset.pageId;
    if (!pid) return;

    // Toggle this single page
    if (state.selectedPageIds.has(pid)) {
      state.selectedPageIds.delete(pid);
      item.classList.remove('selected');
      item.querySelector('input').checked = false;
    } else {
      state.selectedPageIds.add(pid);
      item.classList.add('selected');
      item.querySelector('input').checked = true;
    }
    updateSelectedCount();
  };
}

// Select all pages (if your UI has a button)
function selectAllPages() {
  state.pages.forEach(p => state.selectedPageIds.add(p.page_id));
  loadPagesChecklist(); // re-render to reflect changes
  toast(`All ${state.pages.length} pages selected`, 'info');
}

// Deselect all pages (if your UI has a button)
function deselectAllPages() {
  state.selectedPageIds.clear();
  loadPagesChecklist();
  toast('No pages selected', 'info');
}

function updateSelectedCount() {
  const n = state.selectedPageIds.size;
  const countEl = $('selectedCount');
  if (countEl) countEl.textContent = `${n} selected`;
  updateSubmitSummary();
}

// ── DRAG & DROP FILE UPLOAD (defined ONCE) ────────────────
const dropZone = $('dropZone');
const fileInput = $('fileInput');

if (dropZone) {
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(Array.from(e.dataTransfer.files));
  });
  dropZone.addEventListener('click', e => { if (!e.target.closest('.upload-label')) fileInput?.click(); });
}
if (fileInput) {
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });
}

function addFiles(newFiles) {
  const videoFiles = newFiles.filter(f => f.type.startsWith('video/'));
  const nonVideo = newFiles.length - videoFiles.length;
  if (nonVideo > 0) toast(`${nonVideo} non-video file(s) skipped`, 'warning');

  if (state.files.length + videoFiles.length > 100) {
    toast('Maximum 100 files allowed', 'error');
    return;
  }

  videoFiles.forEach(f => {
    if (f.size > 500 * 1024 * 1024) {
      toast(`${f.name} exceeds 500MB limit and was skipped`, 'warning');
      return;
    }
    state.files.push({ file: f, name: f.name, size: f.size, customTitle: '' });
  });

  renderFileList();
  updateSubmitSummary();
  updateSchedulePreview();
}

function renderFileList() {
  const wrap = $('fileListWrap');
  const list = $('fileList');
  const badge = $('fileCountBadge');
  if (badge) badge.textContent = `${state.files.length} file${state.files.length !== 1 ? 's' : ''}`;

  if (!state.files.length) {
    if (wrap) wrap.style.display = 'none';
    return;
  }
  if (wrap) wrap.style.display = 'block';
  if (!list) return;

  list.innerHTML = state.files.map((f, i) => `
    <div class="file-item" data-idx="${i}">
      <span class="file-name" title="${f.name}">${f.name}</span>
      <span class="file-size">${formatSize(f.size)}</span>
      <input type="text" class="file-title-input" placeholder="Use master title"
             value="${f.customTitle.replace(/"/g, '&quot;')}" data-idx="${i}" 
             title="Override title for this video only" />
      <button class="file-remove" data-idx="${i}" title="Remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.file-title-input').forEach(inp => {
    inp.addEventListener('input', e => {
      state.files[parseInt(e.target.dataset.idx)].customTitle = e.target.value;
      updateSchedulePreview();
    });
  });

  list.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(btn.dataset.idx);
      state.files.splice(idx, 1);
      renderFileList();
      updateSubmitSummary();
      updateSchedulePreview();
    });
  });
}

// ── SCHEDULE PREVIEW ─────────────────────────────────────
function updateSchedulePreview() {
  const preview = $('schedulePreview');
  const list = $('previewList');
  const startDate = $('startDate')?.value;
  const postTime = $('postTime')?.value;

  if (!state.files.length || !startDate || !postTime) {
    if (preview) preview.style.display = 'none';
    return;
  }

  const [h, m] = postTime.split(':').map(Number);
  const [year, month, day] = startDate.split('-').map(Number);
  const baseUtc = new Date(Date.UTC(year, month - 1, day, h - 6, m, 0, 0));

  if (preview) preview.style.display = 'block';

  const shown = state.files.slice(0, 10);
  if (list) {
    list.innerHTML = shown.map((f, i) => {
      const dt = new Date(baseUtc.getTime() + i * 24 * 60 * 60 * 1000);
      const bst = new Date(dt.getTime() + 6 * 60 * 60 * 1000);
      const label = bst.toLocaleDateString('en-BD', { month: 'short', day: 'numeric' });
      const masterTitle = $('masterTitle')?.value || '';
      const displayName = f.customTitle || masterTitle || f.name;
      return `
        <div class="preview-item">
          <span class="preview-day">Day ${i + 1}</span>
          <span class="preview-file">${displayName}</span>
          <span class="preview-time">${label} · ${postTime} BST</span>
        </div>`;
    }).join('');
  }

  if (state.files.length > 10 && list) {
    list.innerHTML += `<div class="preview-item"><span class="preview-day" style="color:var(--text-muted)">+${state.files.length - 10} more...</span><span></span><span></span></div>`;
  }
}

// ── SUBMIT SUMMARY ────────────────────────────────────────
function updateSubmitSummary() {
  const nFiles = state.files.length;
  const nPages = state.selectedPageIds.size;
  const total = nFiles * nPages;

  const videosEl = $('infoPillVideos');
  const pagesEl = $('infoPillPages');
  const totalEl = $('infoPillTotal');
  if (videosEl) videosEl.textContent = `${nFiles} video${nFiles !== 1 ? 's' : ''}`;
  if (pagesEl) pagesEl.textContent = `${nPages} page${nPages !== 1 ? 's' : ''}`;
  if (totalEl) totalEl.textContent = `${total} total upload${total !== 1 ? 's' : ''}`;

  const startDate = $('startDate')?.value;
  const postTime = $('postTime')?.value;
  const submitBtn = $('submitBtn');
  if (submitBtn) submitBtn.disabled = !(nFiles > 0 && nPages > 0 && startDate && postTime);
}

// ── SET DEFAULT DATE (tomorrow BST) ──────────────────────
(function setDefaultDate() {
  const now = new Date();
  const bstNow = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const tomorrow = new Date(bstNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const startDateInput = $('startDate');
  if (startDateInput) startDateInput.value = tomorrow.toISOString().slice(0, 10);
})();

// ── BULK SUBMIT ───────────────────────────────────────────
const submitBtn = $('submitBtn');
if (submitBtn) {
  submitBtn.addEventListener('click', async () => {
    if (!state.files.length || !state.selectedPageIds.size) return;

    const startDate = $('startDate').value;
    const postTime = $('postTime').value;
    const masterTitle = $('masterTitle')?.value.trim() || '';
    const masterDesc = $('masterDesc')?.value.trim() || '';

    // Validate future date (Facebook requires at least 10 min ahead)
    const [h, m] = postTime.split(':').map(Number);
    const [yr, mo, dy] = startDate.split('-').map(Number);
    const scheduledUtc = new Date(Date.UTC(yr, mo - 1, dy, h - 6, m, 0, 0));
    const tenMinFromNow = new Date(Date.now() + 10 * 60 * 1000);
    if (scheduledUtc < tenMinFromNow) {
      toast('Start time must be at least 13 minutes in the future (Facebook requirement)', 'error');
      return;
    }

    const videoMeta = state.files.map(f => ({ title: f.customTitle || '', description: '' }));

    const formData = new FormData();
    formData.append('pageIds', JSON.stringify(Array.from(state.selectedPageIds)));
    formData.append('masterTitle', masterTitle);
    formData.append('masterDescription', masterDesc);
    formData.append('startDate', startDate);
    formData.append('postTime', postTime);
    formData.append('videoMeta', JSON.stringify(videoMeta));
    state.files.forEach(f => formData.append('videos', f.file));

    showProgressModal('Uploading videos to queue...');
    submitBtn.disabled = true;

    try {
      const result = await api('POST', '/upload/bulk', formData, true);
      state.activeBatchId = result.batchId;
      toast(`${result.totalJobs} upload job(s) queued successfully!`, 'success');
      startProgressPolling(result.batchId, result.totalJobs);
    } catch (e) {
      hideProgressModal();
      submitBtn.disabled = false;
      toast('Upload failed: ' + e.message, 'error');
    }
  });
}

// ── PROGRESS POLLING ─────────────────────────────────────
function showProgressModal(title) {
  const overlay = $('progressOverlay');
  if (!overlay) return;
  const titleEl = $('progressTitle');
  const fill = $('progressFill');
  const pct = $('progressPct');
  const doneEl = $('progressDone');
  const failedEl = $('progressFailed');
  const leftEl = $('progressLeft');
  const closeBtn = $('progressClose');
  if (titleEl) titleEl.textContent = title;
  if (fill) fill.style.width = '0%';
  if (pct) pct.textContent = '0%';
  if (doneEl) doneEl.textContent = '0 done';
  if (failedEl) failedEl.textContent = '0 failed';
  if (leftEl) leftEl.textContent = '0 queued';
  if (closeBtn) closeBtn.style.display = 'none';
  overlay.style.display = 'flex';
}

function hideProgressModal() {
  const overlay = $('progressOverlay');
  if (overlay) overlay.style.display = 'none';
  if (state.progressInterval) {
    clearInterval(state.progressInterval);
    state.progressInterval = null;
  }
}

function startProgressPolling(batchId, totalJobs) {
  let lastDone = 0;
  if (state.progressInterval) clearInterval(state.progressInterval);
  state.progressInterval = setInterval(async () => {
    try {
      const batch = await api('GET', `/queue/batch/${batchId}`);
      const done = batch.done + batch.failed;
      const pct = totalJobs > 0 ? Math.round((done / totalJobs) * 100) : 0;

      const fill = $('progressFill');
      const pctEl = $('progressPct');
      const doneEl = $('progressDone');
      const failedEl = $('progressFailed');
      const leftEl = $('progressLeft');
      if (fill) fill.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      if (doneEl) doneEl.textContent = `${batch.done} done`;
      if (failedEl) failedEl.textContent = `${batch.failed} failed`;
      if (leftEl) leftEl.textContent = `${totalJobs - done} queued`;

      if (batch.status === 'complete' || batch.status === 'partial' || done >= totalJobs) {
        clearInterval(state.progressInterval);
        const msg = batch.failed > 0
          ? `Upload complete with ${batch.failed} error(s). Check logs for details.`
          : `All ${batch.done} video(s) scheduled successfully! They will auto-expire after 7 days.`;
        const titleEl = $('progressTitle');
        if (titleEl) titleEl.textContent = msg;
        const closeBtn = $('progressClose');
        if (closeBtn) closeBtn.style.display = 'block';

        // Reset files after successful upload
        state.files = [];
        renderFileList();
        updateSubmitSummary();
        updateSchedulePreview();
        toast(msg, batch.failed > 0 ? 'warning' : 'success', 6000);
      }
      lastDone = done;
    } catch (e) {
      // batch not found yet, keep polling
    }
  }, 2000);
}

if ($('progressClose')) {
  $('progressClose').addEventListener('click', hideProgressModal);
}

// ── QUEUE STATUS (sidebar) ────────────────────────────────
setInterval(async () => {
  try {
    const qs = await api('GET', '/queue/status');
    const isActive = qs.active > 0 || qs.pending > 0;
    const dot = $('qsDot');
    const label = $('qsLabel');
    const mobileDot = $('mobileQsDot');
    if (dot) dot.classList.toggle('active', isActive);
    if (label) label.textContent = isActive ? `${qs.pending + qs.active} job(s)` : 'Queue idle';
    if (mobileDot) mobileDot.style.background = isActive ? '#00d4ff' : '#64748b';
  } catch {}
}, 5000);

// ── LOGS ─────────────────────────────────────────────────
async function loadLogs() {
  const tbody = $('logsBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Loading...</td></tr>`;

  try {
    const params = new URLSearchParams({
      page: state.logsPage,
      limit: 50,
      ...(state.logsStatusFilter ? { status: state.logsStatusFilter } : {})
    });

    const data = await api('GET', `/logs?${params}`);
    const logs = data.logs || [];
    state.logsTotal = data.total || 0;

    updateLogsStats(logs);

    if (!logs.length) {
      tbody.innerHTML = `<td><td colspan="6" class="table-empty">No uploads found.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(log => {
      const statusClass = `status-${log.status || 'pending'}`;
      const statusLabel = (log.status || 'pending').toUpperCase();
      return `
      <tr>
        <td>
          <div style="font-weight:600;font-size:13px">${escHtml(log.video_title || '—')}</div>
          <div style="font-size:11px;color:var(--text-muted)">${escHtml(log.file_name || '')}</div>
        </td>
        <td>${escHtml(log.page_name || log.page_id)}</td>
        <td class="td-mono">${fmtDate(log.scheduled_time)}</td>
        <td class="td-mono">${fmtDate(log.expire_time)}</td>
        <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
        <td>
          <div style="display:flex;gap:6px;align-items:center">
            ${log.post_id && log.status !== 'deleted' ? `
              <button class="btn-danger" onclick="deletePost('${log.id}','${log.post_id}','${log.page_id}')">
                Delete Post
              </button>` : ''}
            <button class="btn-ghost btn-sm" onclick="deleteLog('${log.id}')">Remove</button>
          </div>
          ${log.error_message ? `<div style="font-size:11px;color:var(--red);margin-top:4px">${escHtml(log.error_message)}</div>` : ''}
        </td>
      </tr>`;
    }).join('');

    renderPagination();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty" style="color:var(--red)">${e.message}</td></tr>`;
  }
}

function updateLogsStats(logs) {
  const totalEl = $('statTotal');
  const scheduledEl = $('statScheduled');
  const pendingEl = $('statPending');
  const failedEl = $('statFailed');
  if (totalEl) totalEl.textContent = state.logsTotal || logs.length;
  const counts = { scheduled: 0, pending: 0, failed: 0 };
  logs.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });
  if (scheduledEl) scheduledEl.textContent = counts.scheduled;
  if (pendingEl) pendingEl.textContent = counts.pending;
  if (failedEl) failedEl.textContent = counts.failed;
}

function renderPagination() {
  const totalPages = Math.ceil(state.logsTotal / 50);
  const paginationDiv = $('logsPagination');
  if (!paginationDiv) return;
  if (totalPages <= 1) { paginationDiv.innerHTML = ''; return; }

  let html = '';
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="btn-ghost btn-sm ${i === state.logsPage ? 'active' : ''}" 
             onclick="goToLogsPage(${i})">${i}</button>`;
  }
  paginationDiv.innerHTML = html;
}

window.goToLogsPage = function(page) {
  state.logsPage = page;
  loadLogs();
};

window.deletePost = async function(logId, postId, pageId) {
  if (!confirm('Delete this video from Facebook? This cannot be undone.')) return;
  try {
    await api('POST', `/logs/${logId}/delete-post`, { postId, pageId });
    toast('Post deleted from Facebook', 'success');
    loadLogs();
  } catch (e) {
    toast('Failed to delete post: ' + e.message, 'error');
  }
};

window.deleteLog = async function(logId) {
  if (!confirm('Remove this log entry?')) return;
  try {
    await api('DELETE', `/logs/${logId}`);
    loadLogs();
  } catch (e) {
    toast('Failed to remove log: ' + e.message, 'error');
  }
};

const refreshLogsBtn = $('refreshLogsBtn');
if (refreshLogsBtn) refreshLogsBtn.addEventListener('click', loadLogs);

const logStatusFilter = $('logStatusFilter');
if (logStatusFilter) {
  logStatusFilter.addEventListener('change', e => {
    state.logsStatusFilter = e.target.value;
    state.logsPage = 1;
    loadLogs();
  });
}

// ── CONNECTED PAGES LIST ──────────────────────────────────
async function loadConnectedPages() {
  const grid = $('connectedPagesGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="empty-state">Loading...</div>';
  await loadPages();

  if (!state.pages.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <span>No pages connected.</span>
        <button class="link-btn" onclick="showSection('connect')">Connect pages →</button>
      </div>`;
    return;
  }

  grid.innerHTML = state.pages.map(page => {
    const initials = page.page_name.slice(0, 2).toUpperCase();
    const picHtml = page.picture_url
      ? `<img src="${page.picture_url}" alt="" onerror="this.style.display='none'" />${initials}`
      : initials;
    return `
    <div class="page-card">
      <div class="page-card-top">
        <div class="page-avatar">${picHtml}</div>
        <div class="page-card-info">
          <div class="page-card-name">${escHtml(page.page_name)}</div>
          <div class="page-card-cat">${escHtml(page.category || 'Page')}</div>
        </div>
      </div>
      <div class="page-card-id">ID: ${page.page_id}</div>
      <div class="page-card-actions">
        <button class="btn-danger" onclick="disconnectPage('${page.page_id}', '${escHtml(page.page_name)}')">
          Disconnect
        </button>
      </div>
    </div>`;
  }).join('');
}

window.disconnectPage = async function(pageId, pageName) {
  if (!confirm(`Disconnect "${pageName}"? You can reconnect anytime.`)) return;
  try {
    await api('DELETE', `/pages/${pageId}`);
    toast(`${pageName} disconnected`, 'success');
    loadConnectedPages();
    loadPagesChecklist();
  } catch (e) {
    toast('Failed to disconnect: ' + e.message, 'error');
  }
};

const refreshConnectedBtn = $('refreshConnectedPagesBtn');
if (refreshConnectedBtn) refreshConnectedBtn.addEventListener('click', loadConnectedPages);

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

// যদি সার্ভার ৪০১ (Unauthorized) পাঠায়, তবে লগইন স্ক্রিন দেখাবে
if (response.status === 401) {
    document.getElementById('loginOverlay').style.display = 'flex';
}
// Expose global functions that may be called from HTML
window.selectAllPages = selectAllPages;
window.deselectAllPages = deselectAllPages;