/* ============================================================
   app.js — FB Bulk Scheduler Frontend Logic (FIXED v2.0)
   FIX 1: Upload sends startDate+postTime correctly to server
   FIX 2: videoMeta JSON sent properly
   FIX 3: Connect page result message fixed
   FIX 4: Schedule validation before submit
   FIX 5: Queue status polling
   FIX 6: Mobile-friendly improvements
   ============================================================ */

// ── STATE ─────────────────────────────────────────────────
const state = {
  pages: [],
  selectedPageIds: new Set(),
  files: [],           // { file, name, size, customTitle, customDescription }
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
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};

// Format ISO string to BST display (UTC+6)
const fmtBST = isoStr => {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d)) return '—';
  const bst = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  return bst.toISOString().replace('T', ' ').slice(0, 16) + ' BST';
};

// Escape HTML to prevent XSS
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── TOAST NOTIFICATIONS ───────────────────────────────────
function toast(msg, type = 'info', duration = 4500) {
  const icons = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || '•'}</span><span class="toast-msg">${msg}</span>`;
  const container = $('toastContainer');
  if (container) container.appendChild(el);
  // Animate in
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 350);
  }, duration);
}

// ── API CALLS ─────────────────────────────────────────────
async function api(method, path, body, isFormData = false) {
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

// ── PAGES CHECKLIST ───────────────────────────────────────
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
    const actionBtn = $('pageSelectActions');
    if (actionBtn) actionBtn.style.display = 'none';
    // Rebind goto buttons
    checklistEl.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => showSection(btn.dataset.goto));
    });
    return;
  }

  checklistEl.innerHTML = pages.map(p => `
    <label class="page-checkbox">
      <input type="checkbox" value="${p.page_id}" data-name="${escHtml(p.page_name)}" />
      <span class="checkbox-visual"></span>
      <span class="page-label">
        ${p.picture_url ? `<img src="${p.picture_url}" alt="" loading="lazy" />` : '<div class="page-avatar-placeholder">📄</div>'}
        <div>
          <strong>${escHtml(p.page_name)}</strong>
          <small>${p.page_id}</small>
        </div>
      </span>
    </label>
  `).join('');

  const actionBtn = $('pageSelectActions');
  if (actionBtn) actionBtn.style.display = 'flex';

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
    if (checked === 0) {
      countEl.textContent = 'None selected';
    } else if (checked === all && all > 0) {
      countEl.textContent = `${checked} selected (all)`;
    } else {
      countEl.textContent = `${checked} selected`;
    }
  }
}

function selectAllPages() {
  document.querySelectorAll('#pagesChecklist input[type="checkbox"]').forEach(cb => {
    cb.checked = true;
    state.selectedPageIds.add(cb.value);
  });
  updatePageSelectButtons();
  updateSubmitSummary();
}

function deselectAllPages() {
  document.querySelectorAll('#pagesChecklist input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
  });
  state.selectedPageIds.clear();
  updatePageSelectButtons();
  updateSubmitSummary();
}

// ── PAGES GRID (connected pages display) ─────────────────
async function loadConnectedPages() {
  const grid = $('connectedPagesGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const pages = await loadPages();
    if (pages.length === 0) {
      grid.innerHTML = '<div class="empty-state">No pages connected yet. Go to Connect Pages to add pages.</div>';
      return;
    }

    grid.innerHTML = pages.map(p => `
      <div class="page-card">
        ${p.picture_url
          ? `<img src="${p.picture_url}" alt="" class="page-card-img" loading="lazy" />`
          : '<div class="page-card-img-placeholder">📄</div>'
        }
        <div class="page-card-body">
          <strong>${escHtml(p.page_name)}</strong>
          <small>${p.page_id}</small>
          ${p.category ? `<span class="badge-neutral">${escHtml(p.category)}</span>` : ''}
        </div>
        <button class="btn-icon btn-danger page-delete-btn" data-id="${p.page_id}" title="Remove page">✕</button>
      </div>
    `).join('');

    // Bind delete buttons
    grid.querySelectorAll('.page-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const pid = btn.dataset.id;
        if (!confirm('Remove this page from the system? You can reconnect it later.')) return;
        try {
          await api('DELETE', `/pages/${pid}`);
          toast('Page removed', 'success');
          loadConnectedPages();
          loadPagesChecklist();
        } catch (err) {
          toast('Failed to remove page: ' + err.message, 'error');
        }
      });
    });
  } catch (e) {
    grid.innerHTML = '<div class="empty-state error">Failed to load pages. Please refresh.</div>';
    toast('Failed to load pages: ' + e.message, 'error');
  }
}

// ── FILES DROP ZONE ───────────────────────────────────────
function initDropZone() {
  const dropZone = $('dropZone');
  if (!dropZone) return;

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', e => {
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drag-over');
    }
  });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(Array.from(e.dataTransfer.files));
  });

  const fileInput = $('fileInput');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      addFiles(Array.from(e.target.files));
      fileInput.value = ''; // reset so same file can be re-added
    });
  }
}

function addFiles(files) {
  const videoFiles = files.filter(f => f.type.startsWith('video/'));

  if (videoFiles.length === 0) {
    toast('Please drop video files only (.mp4, .mov, .avi, etc.)', 'warning');
    return;
  }

  const slotsLeft = 100 - state.files.length;
  if (slotsLeft <= 0) {
    toast('Maximum 100 files reached', 'warning');
    return;
  }

  const toAdd = videoFiles.slice(0, slotsLeft);
  if (videoFiles.length > slotsLeft) {
    toast(`Added first ${slotsLeft} files (max 100 total)`, 'warning');
  }

  toAdd.forEach(file => {
    state.files.push({ file, name: file.name, size: file.size, customTitle: null, customDescription: null });
  });

  renderFileList();
  updateSubmitSummary();
  updateSchedulePreview();
}

function renderFileList() {
  const listWrap = $('fileListWrap');
  const fileList = $('fileList');
  const fileCountBadge = $('fileCountBadge');

  if (!listWrap || !fileList) return;

  if (state.files.length === 0) {
    listWrap.style.display = 'none';
    if (fileCountBadge) fileCountBadge.textContent = '0 files';
    return;
  }

  listWrap.style.display = 'block';
  if (fileCountBadge) fileCountBadge.textContent = state.files.length + ' file' + (state.files.length !== 1 ? 's' : '');

  fileList.innerHTML = state.files.map((f, i) => `
    <div class="file-item" data-index="${i}">
      <div class="file-item-info">
        <span class="file-item-idx">#${i + 1}</span>
        <div class="file-item-details">
          <span class="file-item-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>
          <span class="file-item-size">${formatSize(f.size)}</span>
        </div>
      </div>
      <input
        type="text"
        class="file-item-title form-input"
        placeholder="Custom title (optional)"
        value="${escHtml(f.customTitle || '')}"
        data-index="${i}"
        data-field="title"
      />
      <button class="btn-icon btn-danger" onclick="removeFile(${i})" title="Remove this file" aria-label="Remove file">✕</button>
    </div>
  `).join('');

  // Bind title input events
  fileList.querySelectorAll('.file-item-title').forEach(input => {
    input.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.index);
      state.files[idx].customTitle = e.target.value.trim() || null;
      updateSchedulePreview();
    });
  });
}

function removeFile(idx) {
  state.files.splice(idx, 1);
  renderFileList();
  updateSubmitSummary();
  updateSchedulePreview();
}
window.removeFile = removeFile;

// ── CLEAR ALL FILES ───────────────────────────────────────
function clearAllFiles() {
  if (state.files.length === 0) return;
  if (!confirm(`Remove all ${state.files.length} file(s)?`)) return;
  state.files = [];
  renderFileList();
  updateSubmitSummary();
  updateSchedulePreview();
}
window.clearAllFiles = clearAllFiles;

// ── SCHEDULE PREVIEW ──────────────────────────────────────
function updateSchedulePreview() {
  const startDateVal = $('startDate')?.value;
  const postTimeVal = $('postTime')?.value;
  const preview = $('previewList');
  const previewWrap = $('schedulePreview');

  if (!previewWrap) return;

  if (!startDateVal || !postTimeVal || state.files.length === 0) {
    previewWrap.style.display = 'none';
    return;
  }

  previewWrap.style.display = 'block';

  // Build preview in BST (user sees BST times)
  // The input values are already in BST from the user's perspective
  const [year, month, day] = startDateVal.split('-').map(Number);
  const [h, m] = postTimeVal.split(':').map(Number);
  const baseBST = new Date(year, month - 1, day, h, m, 0, 0); // local date object for display

  const items = state.files.map((f, i) => {
    const postTime = new Date(baseBST.getTime() + i * 24 * 60 * 60 * 1000);
    const expireTime = new Date(postTime.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dateStr = postTime.toLocaleDateString('en-BD', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = postTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const expireStr = expireTime.toLocaleDateString('en-BD', { month: 'short', day: 'numeric' });

    return `
      <div class="preview-item">
        <span class="preview-num">#${i + 1}</span>
        <div class="preview-info">
          <span class="preview-name">${escHtml(f.customTitle || f.name)}</span>
          <span class="preview-time">📅 ${dateStr} @ ${timeStr} BST → expires ${expireStr}</span>
        </div>
      </div>
    `;
  });

  if (preview) preview.innerHTML = items.join('');
}

// ── SUBMIT SUMMARY ────────────────────────────────────────
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

// ── VALIDATE SCHEDULE ─────────────────────────────────────
function validateSchedule() {
  const startDateVal = $('startDate')?.value;
  const postTimeVal = $('postTime')?.value;

  if (!startDateVal) {
    toast('Please select a Start Date', 'warning');
    return false;
  }
  if (!postTimeVal) {
    toast('Please select a Post Time', 'warning');
    return false;
  }

  // Parse as BST (UTC+6) — subtract 6 hours to get UTC
  const [year, month, day] = startDateVal.split('-').map(Number);
  const [h, m] = postTimeVal.split(':').map(Number);
  const scheduledUtc = new Date(Date.UTC(year, month - 1, day, h - 6, m, 0, 0));
  const now = new Date();
  const tenMinFromNow = new Date(now.getTime() + 10 * 60 * 1000);

  if (scheduledUtc < tenMinFromNow) {
    toast('Schedule must be at least 10 minutes in the future (Facebook requirement)', 'error');
    return false;
  }

  const sixMonths = new Date(now.getTime() + 6 * 30 * 24 * 60 * 60 * 1000);
  if (scheduledUtc > sixMonths) {
    toast('Schedule cannot be more than 6 months in the future', 'error');
    return false;
  }

  return true;
}

// ── SUBMIT BULK UPLOAD ────────────────────────────────────
function initSubmitButton() {
  const submitBtn = $('submitBtn');
  if (!submitBtn) return;

  submitBtn.addEventListener('click', async () => {
    if (state.files.length === 0) {
      toast('Please add at least one video file', 'warning');
      return;
    }
    if (state.selectedPageIds.size === 0) {
      toast('Please select at least one Facebook page', 'warning');
      return;
    }

    // ── CRITICAL FIX: Validate schedule before sending ──
    if (!validateSchedule()) return;

    const startDateVal = $('startDate').value;
    const postTimeVal = $('postTime').value;
    const masterTitle = $('masterTitle')?.value?.trim() || '';
    const masterDesc = $('masterDesc')?.value?.trim() || '';

    // Build videoMeta array for per-file custom titles
    const videoMeta = state.files.map(f => ({
      title: f.customTitle || masterTitle || f.name,
      description: masterDesc
    }));

    const pageIds = Array.from(state.selectedPageIds);
    const totalUploads = state.files.length * pageIds.length;

    // Show progress modal
    showProgressModal(totalUploads);

    // ── SEND ONE REQUEST WITH ALL FILES TO SERVER ──
    // Server handles scheduling (startDate + postTime in BST + per-video offset)
    try {
      const formData = new FormData();
      state.files.forEach(f => formData.append('videos', f.file));
      formData.append('pageIds', JSON.stringify(pageIds));
      formData.append('videoMeta', JSON.stringify(videoMeta));
      formData.append('startDate', startDateVal);   // BST date e.g. "2025-06-15"
      formData.append('postTime', postTimeVal);     // BST time e.g. "21:00"
      formData.append('masterTitle', masterTitle);
      formData.append('masterDescription', masterDesc);

      setProgressStatus('uploading', `Uploading ${state.files.length} video(s) to server...`);

      const result = await fetch(window.location.origin + '/api/upload/bulk', {
        method: 'POST',
        body: formData
      });

      const data = await result.json();

      if (!result.ok) {
        throw new Error(data.error || `Upload failed (HTTP ${result.status})`);
      }

      // Store batch ID for polling
      state.activeBatchId = data.batchId;
      setProgressStatus('scheduled', `✓ ${data.totalJobs} upload(s) scheduled successfully!`);
      updateProgressModal(data.totalJobs, 0, data.totalJobs);

      toast(`✓ ${data.totalJobs} upload(s) queued successfully!`, 'success', 6000);

      // Start polling batch status
      startBatchPolling(data.batchId, data.totalJobs);

    } catch (err) {
      setProgressStatus('error', '✗ ' + err.message);
      toast('Upload failed: ' + err.message, 'error', 8000);
    }
  });
}

// ── PROGRESS MODAL ────────────────────────────────────────
let progressState = { done: 0, failed: 0, total: 0 };

function showProgressModal(total = 0) {
  const overlay = $('progressOverlay');
  if (overlay) overlay.style.display = 'flex';
  progressState = { done: 0, failed: 0, total };
  updateProgressModal(0, 0, total);
  const closeBtn = $('progressClose');
  if (closeBtn) closeBtn.style.display = 'none';
}

function updateProgressModal(done, failed, total) {
  progressState.done = done;
  progressState.failed = failed;
  if (total !== undefined) progressState.total = total;

  const completed = progressState.done + progressState.failed;
  const pct = progressState.total > 0 ? Math.round((completed / progressState.total) * 100) : 0;

  const progressFill = $('progressFill');
  if (progressFill) progressFill.style.width = pct + '%';

  const progressPct = $('progressPct');
  if (progressPct) progressPct.textContent = pct + '%';

  const progressDone = $('progressDone');
  if (progressDone) progressDone.textContent = progressState.done + ' done';

  const progressFailed = $('progressFailed');
  if (progressFailed) progressFailed.textContent = progressState.failed + ' failed';

  const progressLeft = $('progressLeft');
  const queued = Math.max(0, progressState.total - completed);
  if (progressLeft) progressLeft.textContent = queued + ' queued';

  if (completed >= progressState.total && progressState.total > 0) {
    const closeBtn = $('progressClose');
    if (closeBtn) closeBtn.style.display = 'inline-block';
    if (state.progressInterval) {
      clearInterval(state.progressInterval);
      state.progressInterval = null;
    }
  }
}

function setProgressStatus(type, msg) {
  const statusEl = $('progressStatus');
  if (statusEl) {
    statusEl.textContent = msg;
    statusEl.className = 'progress-status ' + type;
  }
}

function closeProgressModal() {
  const overlay = $('progressOverlay');
  if (overlay) overlay.style.display = 'none';
  if (state.progressInterval) {
    clearInterval(state.progressInterval);
    state.progressInterval = null;
  }
}
window.closeProgressModal = closeProgressModal;

// Poll backend for batch progress
function startBatchPolling(batchId, total) {
  if (state.progressInterval) clearInterval(state.progressInterval);
  state.progressInterval = setInterval(async () => {
    try {
      const data = await api('GET', `/queue/batch/${batchId}`);
      updateProgressModal(data.done || 0, data.failed || 0, total);
      if (data.status === 'complete' || data.status === 'partial') {
        clearInterval(state.progressInterval);
        state.progressInterval = null;
        const msg = data.failed > 0
          ? `⚠ Completed: ${data.done} OK, ${data.failed} failed`
          : `✓ All ${data.done} upload(s) completed!`;
        setProgressStatus(data.failed > 0 ? 'error' : 'scheduled', msg);
      }
    } catch (e) {
      // Batch may not exist yet, ignore
    }
  }, 3000);
}

// ── QUEUE STATUS INDICATOR ────────────────────────────────
function startQueuePolling() {
  setInterval(async () => {
    try {
      const status = await api('GET', '/queue/status');
      const pending = (status.pending || 0) + (status.active || 0);
      const qsDot = $('qsDot');
      const qsLabel = $('qsLabel');
      const mobileQsDot = $('mobileQsDot');
      if (pending > 0) {
        qsDot?.classList.add('active');
        mobileQsDot?.classList.add('active');
        if (qsLabel) qsLabel.textContent = `Queue: ${pending} active`;
      } else {
        qsDot?.classList.remove('active');
        mobileQsDot?.classList.remove('active');
        if (qsLabel) qsLabel.textContent = 'Queue idle';
      }
    } catch (e) { /* ignore */ }
  }, 10000);
}

// ── LOGS ──────────────────────────────────────────────────
async function loadLogs() {
  const tbody = $('logsBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading...</td></tr>';

  try {
    const params = new URLSearchParams({
      page: state.logsPage,
      limit: 50
    });
    if (state.logsStatusFilter) params.set('status', state.logsStatusFilter);

    const result = await api('GET', `/logs?${params}`);
    const logs = result.logs || [];

    if (tbody) {
      if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No logs found</td></tr>';
      } else {
        tbody.innerHTML = logs.map(log => `
          <tr>
            <td class="td-title" title="${escHtml(log.video_title || 'Untitled')}">${escHtml(log.video_title || 'Untitled')}</td>
            <td class="td-page">${escHtml(log.page_name || log.page_id)}</td>
            <td class="td-time">${fmtBST(log.scheduled_time)}</td>
            <td class="td-time">${fmtBST(log.expire_time)}</td>
            <td><span class="status-badge ${log.status}">${log.status}</span></td>
            <td class="td-actions">
              ${log.post_id
                ? `<button class="link-btn btn-danger-text" onclick="deletePost('${escHtml(log.id)}','${escHtml(log.post_id)}','${escHtml(log.page_id)}')">Delete Post</button>`
                : '<span class="text-muted">—</span>'
              }
            </td>
          </tr>
        `).join('');
      }
    }

    // Update stats
    if (result.stats) {
      const stats = result.stats;
      if ($('statTotal')) $('statTotal').textContent = stats.total ?? '—';
      if ($('statScheduled')) $('statScheduled').textContent = stats.scheduled ?? '—';
      if ($('statPending')) $('statPending').textContent = stats.pending ?? '—';
      if ($('statFailed')) $('statFailed').textContent = stats.failed ?? '—';
    }

    state.logsTotal = result.total || 0;
    renderLogsPagination();
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Failed to load logs</td></tr>';
    toast('Failed to load logs: ' + e.message, 'error');
  }
}

async function deletePost(logId, postId, pageId) {
  if (!confirm('Delete this post from Facebook? This cannot be undone.')) return;
  try {
    await api('POST', `/logs/${logId}/delete-post`, { postId, pageId });
    toast('Post deleted from Facebook', 'success');
    loadLogs();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}
window.deletePost = deletePost;

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
  const maxBtns = 7;
  let start = Math.max(1, state.logsPage - 3);
  let end = Math.min(totalPages, start + maxBtns - 1);
  if (end - start < maxBtns - 1) start = Math.max(1, end - maxBtns + 1);

  if (start > 1) html += `<button class="btn-ghost btn-sm" onclick="changePage(1)">« 1</button>`;
  for (let i = start; i <= end; i++) {
    html += `<button class="btn-ghost btn-sm ${i === state.logsPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
  }
  if (end < totalPages) html += `<button class="btn-ghost btn-sm" onclick="changePage(${totalPages})">${totalPages} »</button>`;

  paginationEl.innerHTML = html;
}

function changePage(p) {
  state.logsPage = p;
  loadLogs();
}
window.changePage = changePage;

// Logs filter buttons
function initLogsFilters() {
  const filterBtns = document.querySelectorAll('[data-log-filter]');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.logsStatusFilter = btn.dataset.logFilter;
      state.logsPage = 1;
      loadLogs();
    });
  });
}

// ── CONNECT PAGES ─────────────────────────────────────────
function initConnectPage() {
  const connectBtn = $('connectBtn');
  if (!connectBtn) return;

  connectBtn.addEventListener('click', async () => {
    const tokenInput = $('userTokenInput');
    const token = tokenInput?.value.trim();
    if (!token) {
      toast('Please paste your Facebook User Access Token', 'error');
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    const resultDiv = $('connectResult');
    if (resultDiv) resultDiv.style.display = 'none';

    try {
      // ── FIX: server returns { success, pages, message } ──
      const result = await api('POST', '/auth/connect', { userToken: token });
      const msg = result.message || `✓ ${(result.pages || []).length} page(s) connected successfully!`;

      if (resultDiv) {
        resultDiv.className = 'connect-result success';
        resultDiv.innerHTML = msg;
        resultDiv.style.display = 'block';
      }
      toast(msg, 'success');
      if (tokenInput) tokenInput.value = '';

      // Refresh page lists
      await loadPagesChecklist();
      await loadConnectedPages();

    } catch (e) {
      const errMsg = e.message || 'Connection failed';
      if (resultDiv) {
        resultDiv.className = 'connect-result error';
        resultDiv.innerHTML = '✗ ' + errMsg;
        resultDiv.style.display = 'block';
      }
      toast('Connection failed: ' + errMsg, 'error');
    } finally {
      connectBtn.disabled = false;
      connectBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        Connect & Import Pages`;
    }
  });
}

// ── DATE/TIME VALIDATION UI ───────────────────────────────
function setMinDateTime() {
  const startDateInput = $('startDate');
  if (!startDateInput) return;
  // Minimum: today's date in BST (UTC+6)
  const now = new Date();
  const bstNow = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const minDate = bstNow.toISOString().slice(0, 10);
  startDateInput.setAttribute('min', minDate);
}

// ── NAVIGATION EVENT BINDING ──────────────────────────────
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => showSection(btn.dataset.goto));
  });
}

// ── MOBILE SIDEBAR ────────────────────────────────────────
function initMobileSidebar() {
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
}

// ── SCHEDULE INPUT LISTENERS ──────────────────────────────
function initScheduleListeners() {
  const masterTitle = $('masterTitle');
  const startDate = $('startDate');
  const postTime = $('postTime');

  if (masterTitle) masterTitle.addEventListener('input', updateSchedulePreview);
  if (startDate) startDate.addEventListener('change', () => { updateSchedulePreview(); updateSubmitSummary(); });
  if (postTime) postTime.addEventListener('change', () => { updateSchedulePreview(); updateSubmitSummary(); });
}

// ── REFRESH BUTTON ────────────────────────────────────────
function initRefreshBtn() {
  const refreshBtn = $('refreshPagesBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '...';
      await loadPagesChecklist();
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
    });
  }
}

// ── SELECT ALL / DESELECT ALL BUTTONS ─────────────────────
function initPageSelectBtns() {
  const selAll = $('selectAllPages');
  const deselAll = $('deselectAllPages');
  if (selAll) selAll.addEventListener('click', selectAllPages);
  if (deselAll) deselAll.addEventListener('click', deselectAllPages);
}

// ── INIT ──────────────────────────────────────────────────
(async function init() {
  initNavigation();
  initMobileSidebar();
  initDropZone();
  initSubmitButton();
  initConnectPage();
  initScheduleListeners();
  initLogsFilters();
  initRefreshBtn();
  initPageSelectBtns();
  setMinDateTime();
  startQueuePolling();

  // Load initial data
  await loadPagesChecklist();
  updateSubmitSummary();
})();

// Expose to global for inline HTML calls
window.selectAllPages = selectAllPages;
window.deselectAllPages = deselectAllPages;
