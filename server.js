// server.js — Facebook Bulk Video Scheduler (Express Backend) with Google Authentication
// FIXED: Schedule parsing, videoMeta handling, timezone correction

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const fs = require('fs');
const axios = require('axios'); // বা আপনি যেটা ব্যবহার করছেন
const FormData = require('form-data');
const db = require('./db');
const queue = require('./queue');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== DEV BYPASS (লোকাল টেস্টিং-এ লগইন স্কিপ) ==========
const DEV_BYPASS_AUTH = process.env.NODE_ENV === 'development' && process.env.BYPASS_AUTH === 'true';
// ================================================================

// ─────────────────────────────────────────────
// SESSION & PASSPORT CONFIGURATION (Google Auth)
// ─────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'tahmid_secret_key_123',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set true if using HTTPS
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "https://app.chowdhurydental.com.bd/api/auth/google/callback"
  },
  (accessToken, refreshToken, profile, done) => {
    try {
      const userEmail = profile.emails[0].value;
      if (userEmail === process.env.ALLOWED_EMAIL) {
        return done(null, profile);
      } else {
        return done(null, false, { message: 'Unauthorized email' });
      }
    } catch (err) {
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Authentication guard middleware
const ensureAuthenticated = (req, res, next) => {
  if (DEV_BYPASS_AUTH) {
    req.isAuthenticated = () => true;
    return next();
  }
  if (req.isAuthenticated()) return next();
  res.status(401).send(`
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background:#0f172a; color:white;">
      <h2 style="color:#00d4ff;">CHOWDHURY DENTAL</h2>
      <p>Please login with your Google account to access the video scheduler.</p>
      <a href="/api/auth/google" style="padding:12px 25px; background:#4285F4; color:white; text-decoration:none; border-radius:5px; font-weight:bold; margin-top:10px;">Login with Google</a>
    </div>
  `);
};

/// Multer — store uploads on disk to save RAM
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, '/tmp/'); // রেন্ডার সার্ভারের অস্থায়ী ফোল্ডার
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage, // memoryStorage এর বদলে এখন storage
  limits: { fileSize: 500 * 1024 * 1024 }, // ৫০০ এমবি লিমিট ঠিক থাকল
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});
// ─────────────────────────────────────────────
// UTILITY: Timezone helpers
// ─────────────────────────────────────────────

/**
 * Convert BST (UTC+6) date + time string → UTC Date object
 * e.g. bstToUtc("2025-06-15", "21:00") → Date in UTC (15:00 UTC)
 */
function bstToUtc(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  // BST = UTC+6, so subtract 6 hours to get UTC
  return new Date(Date.UTC(year, month - 1, day, h - 6, m, 0, 0));
}

/**
 * Parse scheduled time from request.
 * Accepts EITHER:
 *   - scheduledTime: ISO string (from frontend's per-upload approach)
 *   - startDate + postTime: BST date+time strings (for bulk batch mode)
 * Returns UTC Date object.
 */
function parseScheduledTime(body, videoIndex = 0) {
  // Mode 1: Direct ISO scheduledTime from frontend
  if (body.scheduledTime) {
    const d = new Date(body.scheduledTime);
    if (isNaN(d.getTime())) {
      throw new Error('Invalid scheduledTime ISO string: ' + body.scheduledTime);
    }
    return d;
  }

  // Mode 2: startDate + postTime in BST, with per-video day offset
  if (body.startDate && body.postTime) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
      throw new Error('Invalid startDate format. Expected YYYY-MM-DD');
    }
    if (!/^\d{2}:\d{2}$/.test(body.postTime)) {
      throw new Error('Invalid postTime format. Expected HH:MM');
    }
    const base = bstToUtc(body.startDate, body.postTime);
    // Add videoIndex * 1 day for staggered scheduling
    return new Date(base.getTime() + videoIndex * 24 * 60 * 60 * 1000);
  }

  throw new Error('scheduledTime (ISO) or startDate + postTime (BST) is required');
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
// GOOGLE AUTH ROUTES (Public)
// ─────────────────────────────────────────────
app.get('/api/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));

app.get('/api/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login-failed' }),
  (req, res) => res.redirect('/')
);

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login-failed', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login-failed.html'));
});

app.get('/', (req, res) => {
  if (req.isAuthenticated() || DEV_BYPASS_AUTH) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/login');
  }
});

// ─────────────────────────────────────────────
// ROUTES: Facebook Token Connect (Protected)
// ─────────────────────────────────────────────
app.post('/api/auth/connect', ensureAuthenticated, asyncHandler(async (req, res) => {
  const shortLivedToken = req.body.userToken || req.body.userAccessToken;

  if (!shortLivedToken) {
    return res.status(400).json({ error: 'ফেসবুক টোকেন পাওয়া যায়নি! আবার ট্রাই করুন।' });
  }

  try {
    const longLived = await queue.exchangeForLongLivedToken(shortLivedToken);
    const pages = await queue.fetchUserPages(longLived.access_token);

    if (!pages || pages.length === 0) {
      return res.status(400).json({ error: 'এই টোকেনে কোনো পেজ খুঁজে পাওয়া যায়নি।' });
    }

    const savedPages = [];
    for (const page of pages) {
      const saved = await db.savePage({
        page_id: page.id,
        page_name: page.name,
        access_token: page.access_token,
        picture_url: page.picture?.data?.url || null,
        category: page.category || null
      });
      savedPages.push({ id: saved.page_id, name: saved.page_name });
    }

    res.json({
      success: true,
      pages: savedPages,
      message: `✓ ${savedPages.length}টি পেজ সফলভাবে সংযুক্ত হয়েছে!`
    });

  } catch (err) {
    const fbMsg = err.response?.data?.error?.message || err.message;
    console.error("FB Connect Error:", fbMsg);
    res.status(400).json({ error: fbMsg });
  }
}));

// ─────────────────────────────────────────────
// ROUTES: Pages (Protected)
// ─────────────────────────────────────────────
app.get('/api/pages', ensureAuthenticated, asyncHandler(async (req, res) => {
  const pages = await db.getPages();
  res.json({ pages });
}));

app.delete('/api/pages/:pageId', ensureAuthenticated, asyncHandler(async (req, res) => {
  await db.deletePage(req.params.pageId);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// ROUTES: Bulk Upload & Scheduling (Protected)
// ─────────────────────────────────────────────
app.post('/api/upload/bulk', ensureAuthenticated, upload.array('videos', 100), asyncHandler(async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No video files provided' });
  }

  // Parse pageIds
  let pageIds, videoMeta;
  try {
    pageIds = JSON.parse(req.body.pageIds || '[]');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON in pageIds' });
  }

  // Parse videoMeta (optional per-video metadata array)
  try {
    videoMeta = JSON.parse(req.body.videoMeta || '[]');
  } catch {
    videoMeta = [];
  }

  if (!pageIds.length) {
    return res.status(400).json({ error: 'At least one page must be selected' });
  }

  const { masterTitle, masterDescription } = req.body;

  // ── CRITICAL FIX: Parse scheduled time properly ──
  // Accepts scheduledTime (ISO) OR startDate+postTime (BST)
  let firstScheduledUtc;
  try {
    firstScheduledUtc = parseScheduledTime(req.body, 0);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Facebook requires scheduled time to be at least 10 minutes in the future
  const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000);
  if (firstScheduledUtc < tenMinutesFromNow) {
    return res.status(400).json({
      error: 'Scheduled time must be at least 10 minutes in the future (Facebook requirement). Please select a later time.'
    });
  }

  // Facebook also requires scheduled time to be no more than 6 months ahead
  const sixMonthsFromNow = new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000);
  if (firstScheduledUtc > sixMonthsFromNow) {
    return res.status(400).json({
      error: 'Scheduled time cannot be more than 6 months in the future (Facebook requirement).'
    });
  }

  // Load page records from DB
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

  for (let videoIndex = 0; videoIndex < files.length; videoIndex++) {
    const file = files[videoIndex];
    const perVideoMeta = videoMeta[videoIndex] || {};
    const title = perVideoMeta.title || masterTitle || '';
    const description = perVideoMeta.description || masterDescription || '';

    // Each video is scheduled 1 day apart from the first
    const scheduledTime = new Date(firstScheduledUtc.getTime() + videoIndex * 24 * 60 * 60 * 1000);
    const expireTime = addDaysToDate(scheduledTime, 7);

    for (const page of pageRecords) {
      const logEntry = await db.createUploadLog({
        video_title: title || file.originalname,
        page_id: page.page_id,
        page_name: page.page_name,
        scheduled_time: scheduledTime.toISOString(),
        expire_time: expireTime.toISOString(),
        file_name: file.originalname,
        file_size: file.size
      });

      queue.enqueueUpload({
        jobId: uuidv4(),
        batchId,
        logId: logEntry.id,
        pageId: page.page_id,
        accessToken: page.access_token,
        filePath: file.path,
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
// ROUTES: Queue Status (Protected)
// ─────────────────────────────────────────────
app.get('/api/queue/status', ensureAuthenticated, (req, res) => {
  res.json(queue.getQueueStatus());
});

app.get('/api/queue/batch/:batchId', ensureAuthenticated, (req, res) => {
  const batch = queue.activeJobs.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  res.json({ batchId: req.params.batchId, ...batch });
});

// ─────────────────────────────────────────────
// ROUTES: Upload Logs (Dashboard) (Protected)
// ─────────────────────────────────────────────
app.get('/api/logs', ensureAuthenticated, asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, status, pageId } = req.query;
  const result = await db.getUploadLogs({
    page: parseInt(page),
    limit: parseInt(limit),
    status,
    pageId
  });
  res.json(result);
}));

app.delete('/api/logs/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
  await db.deleteUploadLog(req.params.id);
  res.json({ success: true });
}));

app.post('/api/logs/:id/delete-post', ensureAuthenticated, asyncHandler(async (req, res) => {
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
// ROUTES: Health Check (Public)
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    queue: queue.getQueueStatus()
  });
});

// ─────────────────────────────────────────────
// CATCH-ALL: serve frontend (Protected)
// ─────────────────────────────────────────────
app.get('*', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
// START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   FB Bulk Video Scheduler — v2.0 FIXED       ║
║   Server running at http://localhost:${PORT}    ║
║   Dev bypass: ${DEV_BYPASS_AUTH ? 'ON (no login required)' : 'OFF'}          ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = app;
