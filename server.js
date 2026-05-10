// server.js — Facebook Bulk Video Scheduler (Express Backend)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const queue = require('./queue');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer — store uploads in memory (for chunked forwarding to FB)
// Limit: 500MB per file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/avi', 'video/mpeg'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});

// ─────────────────────────────────────────────
// UTILITY: BST timezone helpers
// ─────────────────────────────────────────────
// BST = UTC+6. Converts "YYYY-MM-DD HH:mm" in BST to UTC Date
function bstToUtc(dateStr, timeStr) {
  // dateStr: "2025-02-01", timeStr: "21:00"
  const [h, m] = timeStr.split(':').map(Number);
  const [year, month, day] = dateStr.split('-').map(Number);
  // BST is UTC+6, so subtract 6 hours
  const utc = new Date(Date.UTC(year, month - 1, day, h - 6, m, 0, 0));
  return utc;
}

function addDaysToDate(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// ─────────────────────────────────────────────
// ERROR HANDLER WRAPPER
// ─────────────────────────────────────────────
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ─────────────────────────────────────────────
// ROUTES: Facebook OAuth / Token Exchange
// ─────────────────────────────────────────────

// Exchange short-lived user token → fetch pages with long-lived page tokens
app.post('/api/auth/connect', asyncHandler(async (req, res) => {
  const { userToken } = req.body;
  if (!userToken) return res.status(400).json({ error: 'userToken is required' });

  try {
    // 1. Exchange for long-lived user token
    const longLived = await queue.exchangeForLongLivedToken(userToken);
    const longLivedUserToken = longLived.access_token;

    // 2. Fetch all pages with their page-level tokens
    const pages = await queue.fetchUserPages(longLivedUserToken);

    if (!pages.length) {
      return res.status(400).json({ error: 'No pages found for this user token. Make sure pages_manage_posts and publish_video permissions are granted.' });
    }

    // 3. Save each page to DB (page tokens are already long-lived)
    const savedPages = [];
    for (const page of pages) {
      try {
        const saved = await db.savePage({
          page_id: page.id,
          page_name: page.name,
          access_token: page.access_token,
          picture_url: page.picture?.data?.url || null,
          category: page.category || null
        });
        savedPages.push({ id: saved.page_id, name: saved.page_name });
      } catch (e) {
        console.error(`Failed to save page ${page.name}:`, e.message);
      }
    }

    res.json({
      success: true,
      message: `Connected ${savedPages.length} page(s) successfully`,
      pages: savedPages
    });

  } catch (err) {
    const fbError = err.response?.data?.error?.message || err.message;
    res.status(400).json({ error: fbError });
  }
}));

// ─────────────────────────────────────────────
// ROUTES: Pages
// ─────────────────────────────────────────────

app.get('/api/pages', asyncHandler(async (req, res) => {
  const pages = await db.getPages();
  res.json({ pages });
}));

app.delete('/api/pages/:pageId', asyncHandler(async (req, res) => {
  await db.deletePage(req.params.pageId);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// ROUTES: Bulk Upload & Scheduling
// ─────────────────────────────────────────────

// POST /api/upload/bulk
// Body: multipart/form-data
// Fields:
//   - videos[]: Array of video files
//   - pageIds: JSON array of page IDs to post to
//   - masterTitle: (optional) applied to all videos
//   - masterDescription: (optional) applied to all videos
//   - videoMeta: JSON array of per-video overrides [{title, description}]
//   - startDate: "YYYY-MM-DD" in BST
//   - postTime: "HH:mm" in BST (24h)
app.post('/api/upload/bulk', upload.array('videos', 100), asyncHandler(async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No video files provided' });
  }

  let pageIds, videoMeta;
  try {
    pageIds = JSON.parse(req.body.pageIds || '[]');
    videoMeta = JSON.parse(req.body.videoMeta || '[]');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON in pageIds or videoMeta' });
  }

  if (!pageIds.length) {
    return res.status(400).json({ error: 'At least one page must be selected' });
  }

  const { startDate, postTime, masterTitle, masterDescription } = req.body;

  if (!startDate || !postTime) {
    return res.status(400).json({ error: 'startDate and postTime are required' });
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{2}:\d{2}$/.test(postTime)) {
    return res.status(400).json({ error: 'Invalid startDate or postTime format' });
  }

  // Ensure start time is in the future (at least 10 minutes from now)
  const firstScheduledUtc = bstToUtc(startDate, postTime);
  const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000);
  if (firstScheduledUtc < tenMinutesFromNow) {
    return res.status(400).json({ error: 'Scheduled time must be at least 10 minutes in the future (Facebook requirement)' });
  }

  // Fetch page records from DB
  const pageRecords = [];
  for (const pid of pageIds) {
    try {
      const page = await db.getPage(pid);
      pageRecords.push(page);
    } catch {
      return res.status(400).json({ error: `Page ${pid} not found in database. Please reconnect it.` });
    }
  }

  const batchId = uuidv4();
  const jobResults = [];
  let videoIndex = 0;

  // For each video × each page → schedule a post
  for (const file of files) {
    const perVideoMeta = videoMeta[videoIndex] || {};
    const title = perVideoMeta.title || masterTitle || '';
    const description = perVideoMeta.description || masterDescription || '';

    // Each video gets its own day slot (Video 0 → Day 0, Video 1 → Day 1...)
    const scheduledTime = addDaysToDate(firstScheduledUtc, videoIndex);
    const expireTime = addDaysToDate(scheduledTime, 7); // 7 days after publish

    for (const page of pageRecords) {
      // Create DB log entry
      const logEntry = await db.createUploadLog({
        video_title: title || file.originalname,
        page_id: page.page_id,
        page_name: page.page_name,
        scheduled_time: scheduledTime.toISOString(),
        expire_time: expireTime.toISOString(),
        file_name: file.originalname,
        file_size: file.size
      });

      // Enqueue the upload job
      queue.enqueueUpload({
        jobId: uuidv4(),
        batchId,
        logId: logEntry.id,
        pageId: page.page_id,
        accessToken: page.access_token,
        fileBuffer: file.buffer,
        videoMeta: {
          title,
          description,
          scheduledTime: scheduledTime.toISOString(),
          expireTime: expireTime.toISOString()
        }
      });

      jobResults.push({
        logId: logEntry.id,
        fileName: file.originalname,
        pageName: page.page_name,
        scheduledTime: scheduledTime.toISOString(),
        expireTime: expireTime.toISOString()
      });
    }

    videoIndex++;
  }

  res.json({
    success: true,
    batchId,
    totalJobs: jobResults.length,
    jobs: jobResults,
    message: `${files.length} video(s) queued for ${pageIds.length} page(s) = ${jobResults.length} total uploads`
  });
}));

// ─────────────────────────────────────────────
// ROUTES: Queue Status (for progress polling)
// ─────────────────────────────────────────────
app.get('/api/queue/status', (req, res) => {
  res.json(queue.getQueueStatus());
});

app.get('/api/queue/batch/:batchId', (req, res) => {
  const batch = queue.activeJobs.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  res.json({ batchId: req.params.batchId, ...batch });
});

// ─────────────────────────────────────────────
// ROUTES: Upload Logs (Dashboard)
// ─────────────────────────────────────────────
app.get('/api/logs', asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, status, pageId } = req.query;
  const result = await db.getUploadLogs({
    page: parseInt(page),
    limit: parseInt(limit),
    status,
    pageId
  });
  res.json(result);
}));

app.delete('/api/logs/:id', asyncHandler(async (req, res) => {
  await db.deleteUploadLog(req.params.id);
  res.json({ success: true });
}));

// Manually delete a Facebook video post
app.post('/api/logs/:id/delete-post', asyncHandler(async (req, res) => {
  const { postId, pageId } = req.body;
  if (!postId || !pageId) {
    return res.status(400).json({ error: 'postId and pageId required' });
  }

  const page = await db.getPage(pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  try {
    await queue.deleteVideoPost(postId, page.access_token);
    await db.updateUploadLog(req.params.id, { status: 'deleted' });
    res.json({ success: true, message: 'Post deleted from Facebook' });
  } catch (err) {
    const fbError = err.response?.data?.error?.message || err.message;
    res.status(400).json({ error: fbError });
  }
}));

// ─────────────────────────────────────────────
// ROUTES: Health Check
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    queue: queue.getQueueStatus()
  });
});

// ─────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 500MB per video.' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field. Use videos[] for file uploads.' });
  }

  res.status(500).json({
    error: err.message || 'Internal server error'
  });
});

// ─────────────────────────────────────────────
// CATCH-ALL: serve frontend
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   FB Bulk Video Scheduler                    ║
║   Server running at http://localhost:${PORT}    ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = app;
