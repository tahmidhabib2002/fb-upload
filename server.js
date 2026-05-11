// server.js — Facebook Bulk Video Scheduler (Express Backend) with Google Authentication

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

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
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "https://app.chowdhurydental.com.bd/api/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const userEmail = profile.emails[0].value;
      const allowedEmail = process.env.ALLOWED_EMAIL;
      
      console.log(`[Auth] Login attempt from: ${userEmail}`);
      
      if (allowedEmail && userEmail === allowedEmail) {
        console.log(`[Auth] Access granted for: ${userEmail}`);
        return done(null, { ...profile, email: userEmail });
      } else if (!allowedEmail) {
        console.warn('[Auth] No ALLOWED_EMAIL set in .env - allowing all users temporarily');
        return done(null, { ...profile, email: userEmail });
      } else {
        console.warn(`[Auth] Access denied for: ${userEmail}`);
        return done(null, false, { message: 'Unauthorized email' });
      }
    } catch (err) {
      console.error('[Auth] Error:', err);
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 'https://app.chowdhurydental.com.bd' : 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Authentication guard middleware
const ensureAuthenticated = (req, res, next) => {
  if (DEV_BYPASS_AUTH) {
    req.user = { email: 'dev@test.com' };
    req.isAuthenticated = () => true;
    return next();
  }
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  
  // API requests return 401 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized - Please login', redirect: '/login' });
  }
  
  // HTML requests show login page
  res.status(401).send(`
    <!DOCTYPE html>
    <html>
    <head><title>Login Required</title><meta http-equiv="refresh" content="0;url=/login"></head>
    <body>Redirecting to login...</body>
    </html>
  `);
};

// Multer — store uploads in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/avi', 'video/mpeg', 'video/webm'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});

// ─────────────────────────────────────────────
// UTILITY: BST timezone helpers (UTC+6)
// ─────────────────────────────────────────────
function bstToUtc(dateStr, timeStr) {
  // Parse BST time (UTC+6)
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  
  // Create date in local time (assuming system time is UTC)
  const localDate = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
  
  // Convert BST (UTC+6) to UTC by subtracting 6 hours
  const utcDate = new Date(localDate.getTime() - (6 * 60 * 60 * 1000));
  
  return utcDate;
}

function addDaysToDate(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatBST(date) {
  if (!date) return '';
  const d = new Date(date);
  const bst = new Date(d.getTime() + (6 * 60 * 60 * 1000));
  return bst.toISOString().slice(0, 16).replace('T', ' ');
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
  (req, res) => {
    console.log('[Auth] Login successful, redirecting to /');
    res.redirect('/');
  }
);

app.get('/api/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) console.error('[Auth] Logout error:', err);
    res.redirect('/login');
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ 
    authenticated: DEV_BYPASS_AUTH ? true : (req.isAuthenticated ? req.isAuthenticated() : false),
    user: req.user ? { email: req.user.email } : null
  });
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login-failed', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login-failed.html'));
});

app.get('/', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else if (DEV_BYPASS_AUTH) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/login');
  }
});

// ─────────────────────────────────────────────
// ROUTES: Facebook OAuth / Token Exchange (Protected)
// ─────────────────────────────────────────────
app.post('/api/auth/connect', ensureAuthenticated, asyncHandler(async (req, res) => {
  const shortLivedToken = req.body.userToken || req.body.userAccessToken;

  if (!shortLivedToken) {
    return res.status(400).json({ error: 'ফেসবুক টোকেন পাওয়া যায়নি! আবার ট্রাই করুন।' });
  }

  try {
    // ১. টোকেন এক্সচেঞ্জ
    const longLived = await queue.exchangeForLongLivedToken(shortLivedToken);
    
    // ২. পেজগুলো নিয়ে আসা
    const pages = await queue.fetchUserPages(longLived.access_token);

    if (!pages || pages.length === 0) {
      return res.status(400).json({ error: 'এই টোকেনে কোনো পেজ খুঁজে পাওয়া যায়নি।' });
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
      savedPages.push({ id: saved.page_id, name: saved.page_name, picture: page.picture?.data?.url });
    }

    res.json({ success: true, pages: savedPages, message: `${savedPages.length} পেজ সফলভাবে সংযুক্ত হয়েছে` });

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

  let pageIds, videoMeta;
  try {
    pageIds = JSON.parse(req.body.pageIds || '[]');
    videoMeta = JSON.parse(req.body.videoMeta || '[]');
  } catch (err) {
    console.error('Parse error:', err);
    return res.status(400).json({ error: 'Invalid JSON in pageIds or videoMeta' });
  }

  if (!pageIds.length) {
    return res.status(400).json({ error: 'At least one page must be selected' });
  }

  const { startDate, postTime, masterTitle, masterDescription } = req.body;

  if (!startDate || !postTime) {
    return res.status(400).json({ error: 'startDate and postTime are required' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{2}:\d{2}$/.test(postTime)) {
    return res.status(400).json({ error: 'Invalid startDate or postTime format' });
  }

  const firstScheduledUtc = bstToUtc(startDate, postTime);
  const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000);
  
  if (firstScheduledUtc < tenMinutesFromNow) {
    return res.status(400).json({ 
      error: `Scheduled time must be at least 10 minutes in the future. Current time (BST): ${formatBST(new Date())}, Selected: ${formatBST(firstScheduledUtc)}`
    });
  }

  // Get all selected pages
  const pageRecords = [];
  for (const pid of pageIds) {
    try {
      const page = await db.getPage(pid);
      if (!page) {
        return res.status(400).json({ error: `Page ${pid} not found. Please reconnect it.` });
      }
      pageRecords.push(page);
    } catch (err) {
      console.error(`Error fetching page ${pid}:`, err);
      return res.status(400).json({ error: `Page ${pid} not found. Please reconnect it.` });
    }
  }

  const batchId = uuidv4();
  const jobResults = [];
  
  // Track progress in memory
  const batchProgress = {
    total: files.length * pageRecords.length,
    done: 0,
    failed: 0,
    status: 'running'
  };
  queue.activeJobs.set(batchId, batchProgress);

  // For each video file
  for (let videoIndex = 0; videoIndex < files.length; videoIndex++) {
    const file = files[videoIndex];
    const perVideoMeta = videoMeta[videoIndex] || {};
    const title = perVideoMeta.title || masterTitle || '';
    const description = perVideoMeta.description || masterDescription || '';
    
    // Schedule this video at startDate + videoIndex days
    const scheduledTime = addDaysToDate(firstScheduledUtc, videoIndex);
    const expireTime = addDaysToDate(scheduledTime, 7);

    // For each selected page
    for (const page of pageRecords) {
      // Create log entry
      const logEntry = await db.createUploadLog({
        video_title: title || file.originalname,
        page_id: page.page_id,
        page_name: page.page_name,
        scheduled_time: scheduledTime.toISOString(),
        expire_time: expireTime.toISOString(),
        file_name: file.originalname,
        file_size: file.size,
        batch_id: batchId
      });

      // Enqueue upload job
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
  }

  res.json({
    success: true,
    batchId,
    totalJobs: jobResults.length,
    jobs: jobResults,
    message: `${files.length} ভিডিও ${pageRecords.length} পেজে সিডিউল করা হয়েছে (মোট ${jobResults.length} টি আপলোড)`
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
  
  // Also get stats
  const stats = await db.getUploadStats();
  
  res.json({ 
    logs: result.logs, 
    total: result.total,
    stats: {
      total: result.total,
      scheduled: stats?.scheduled || 0,
      pending: stats?.pending || 0,
      failed: stats?.failed || 0
    }
  });
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
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    timezone: 'BST (UTC+6)',
    currentTimeBST: formatBST(new Date())
  });
});

// ─────────────────────────────────────────────
// CATCH-ALL: serve frontend
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
╔══════════════════════════════════════════════════════╗
║     FB Bulk Video Scheduler with Google Auth         ║
║     Server running at http://localhost:${PORT}         ║
║     Dev bypass: ${DEV_BYPASS_AUTH ? 'ON (no login required)' : 'OFF'}                ║
║     Current BST: ${formatBST(new Date())}              ║
╚══════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
