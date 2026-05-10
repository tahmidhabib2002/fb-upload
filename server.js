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

const app = express(); // ১. আগে অ্যাপ তৈরি হবে
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// ২. সিকিউরিটি এবং সেশন সেটআপ (এই ক্রমটি খুব জরুরি)
// ─────────────────────────────────────────────
app.use(session({
  secret: 'chowdhury_dental_secret',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/api/auth/google/callback"
  },
  (accessToken, refreshToken, profile, done) => {
    // ইমেইল চেক
    if (profile.emails && profile.emails[0].value === process.env.ALLOWED_EMAIL) {
      return done(null, profile);
    } else {
      return done(null, false);
    }
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// সিকিউরিটি গার্ড (Middleware)
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Unauthorized! Please login." });
};

// ─────────────────────────────────────────────
// ৩. অথেন্টিকেশন রুটসমূহ
// ─────────────────────────────────────────────
app.get('/api/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));

app.get('/api/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-failed' }),
  (req, res) => res.redirect('/')
);

app.get('/api/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ─────────────────────────────────────────────
// ৪. অন্যান্য মিডলওয়্যার
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────────
// ৫. সুরক্ষিত এপিআই রুটসমূহ (ensureAuthenticated যুক্ত করা হয়েছে)
// ─────────────────────────────────────────────

app.post('/api/auth/connect', ensureAuthenticated, async (req, res) => {
    // আপনার কানেক্ট কোড...
});

app.get('/api/pages', ensureAuthenticated, async (req, res) => {
  const pages = await db.getPages();
  res.json({ pages });
});

// আপলোড রুটে তালা লাগানো হলো
app.post('/api/upload/bulk', ensureAuthenticated, multer({ storage: multer.memoryStorage() }).array('videos', 100), async (req, res) => {
    // আপনার আপলোড কোড...
});

app.get('/api/logs', ensureAuthenticated, async (req, res) => {
  const result = await db.getUploadLogs(req.query);
  res.json(result);
});

// ─────────────────────────────────────────────
// ৬. ফ্রন্টএন্ড পরিবেশন (Static Files)
// ─────────────────────────────────────────────

// স্ট্যাটিক ফাইলগুলো সবার জন্য খোলা থাকবে (CSS/JS লোড হওয়ার জন্য)
app.use(express.static(path.join(__dirname, 'public')));

// মেইন পেজে তালা লাগানো হলো
app.get('*', (req, res) => {
  if (req.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    // লগইন না থাকলে গুগল লগইন পেজে পাঠিয়ে দেবে
    res.redirect('/api/auth/google');
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});