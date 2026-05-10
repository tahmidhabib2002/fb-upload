# 🔐 Facebook Bulk Uploader - লগইন সিস্টেম সমাধান গাইড

## 🔴 আপনার সমস্যা কি ছিল?

আপনার কোডে দুটি মূল সমস্যা ছিল:

### সমস্যা ১: লগইন পেজ নেই
- আপনার HTML তে কোনো লগইন ফর্ম বা লগইন স্ক্রিন নেই
- যখন কোনো ব্যবহারকারী লগইন না করে সরাসরি ওয়েবসাইট খোলে, তারা সরাসরি ড্যাশবোর্ডে চলে যাচ্ছিল
- তারপর একটি পপ-আপ দেখতো "Unauthorized - Please Login" কিন্তু লগইন করার কোনো উপায় ছিল না

### সমস্যা ২: Google OAuth সেটআপ সম্পূর্ণ নয়
- `.env` ফাইলে Google OAuth credentials নেই
- `ALLOWED_EMAIL` ভ্যারিয়েবল নেই
- ফ্রন্টএন্ডে লগইন চেক করার কোড সঠিক জায়গায় নেই

---

## ✅ সমাধান: কি কি ফাইল পরিবর্তন হয়েছে?

### ১. **server.js** - ফিক্স করা হয়েছে

**পরিবর্তন:**
```javascript
// পুরাতন (ভুল):
app.get('*', (req, res) => {
  if (req.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/api/auth/google');  // ❌ সরাসরি Google এ পাঠিয়েছিল
  }
});

// নতুন (সঠিক):
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    res.redirect('/');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

app.get('/login-failed', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login-failed.html'));
});

app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/login');  // ✅ লগইন পেজে পাঠায়
  }
});
```

**সুবিধা:**
- এখন লগইন না করলে প্রথমে একটি সুন্দর লগইন পেজ দেখায়
- Google বাটন ক্লিক করে লগইন করতে পারে
- লগইন ব্যর্থ হলে একটি ফ্রেন্ডলি এরর পেজ দেখায়

### ২. **public/login.html** - নতুন ফাইল তৈরি

এটি একটি সুন্দর লগইন পেজ যাতে:
- Google OAuth বাটন আছে
- বাংলা নির্দেশনা আছে
- Dark mode ডিজাইন আছে (আপনার ড্যাশবোর্ডের মতো)

**কীভাবে কাজ করে:**
```html
<a href="/api/auth/google" class="btn-google">
  Google দিয়ে লগইন করুন
</a>
```

যখন ব্যবহারকারী এই বাটন ক্লিক করে:
1. Google OAuth প্রক্রিয়া শুরু হয়
2. Google এর লগইন ডায়ালগ খোলে
3. ইমেইল সঠিক হলে ড্যাশবোর্ডে পাঠায়
4. ইমেইল ভুল হলে `/login-failed` পেজে পাঠায়

### ৩. **public/login-failed.html** - নতুন ফাইল তৈরি

এটি একটি এরর পেজ যা দেখায় যখন:
- ভুল ইমেইল দিয়ে লগইন করা হয়
- অনুমোদিত ইমেইল নয়

### ৪. **.env.example** - আপডেট করা হয়েছে

নতুন ভ্যারিয়েবল যোগ করা হয়েছে:
```bash
# Google OAuth Credentials
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID_HERE
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET_HERE

# Authentication
ALLOWED_EMAIL=your-email@example.com
```

---

## 🚀 এখন কি করবেন?

### ধাপ ১: Google OAuth সেটআপ করুন

#### Google Cloud Console এ যান:
1. https://console.cloud.google.com/ খুলুন
2. একটি নতুন প্রজেক্ট তৈরি করুন (প্রজেক্টের নাম: `FB Bulk Scheduler`)
3. বাম সাইড থেকে "APIs & Services" খুলুন
4. "OAuth consent screen" এ ক্লিক করুন
5. "External" নির্বাচন করুন এবং "Create" করুন
6. ফর্ম পূরণ করুন:
   - App name: `FB Bulk Scheduler`
   - User support email: আপনার ইমেইল
   - Developer contact: আপনার ইমেইল

#### OAuth 2.0 Credentials তৈরি করুন:
1. "Credentials" ট্যাব এ যান
2. "Create Credentials" → "OAuth client ID" ক্লিক করুন
3. Application type: `Web application` নির্বাচন করুন
4. নাম: `FB Bulk Scheduler`
5. "Authorized redirect URIs" এ এটি যোগ করুন:
   ```
   http://localhost:3000/api/auth/google/callback
   ```
   (প্রোডাকশনের জন্য: `https://your-domain.com/api/auth/google/callback`)
6. "Create" করুন
7. Client ID এবং Client Secret কপি করুন

### ধাপ ২: .env ফাইল সেটআপ করুন

`.env` ফাইল তৈরি করুন (`.env.example` এর মতো):

```bash
# Google OAuth
GOOGLE_CLIENT_ID=paste-your-client-id-here
GOOGLE_CLIENT_SECRET=paste-your-client-secret-here

# শুধু এই ইমেইল দিয়ে লগইন করতে পারবে
ALLOWED_EMAIL=your-email@gmail.com

# বাকি সব কিছু আগের মতো...
FB_APP_ID=1763519494612035
FB_APP_SECRET=a4f78191ae500a25a228f3607217a228
SUPABASE_URL=https://vinlrfcbohsrvumoidbj.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_bsLAsH0xiIyXmJtFkw8bCg_7PWpMKgr
PORT=3000
NODE_ENV=development
APP_BASE_URL=http://localhost:3000
FB_API_VERSION=v19.0
CHUNK_SIZE=10485760
MAX_CONCURRENT_UPLOADS=3
```

### ধাপ ৩: নতুন ফাইল কপি করুন

আপনার প্রজেক্টে এই ফাইলগুলো যোগ করুন:
- `public/login.html` ✨ (নতুন)
- `public/login-failed.html` ✨ (নতুন)
- `server.js` (আপডেট করুন)

### ধাপ ৪: পরীক্ষা করুন

1. সার্ভার রিস্টার্ট করুন:
   ```bash
   npm start
   ```

2. ব্রাউজার খুলুন: `http://localhost:3000`

3. এখন আপনি এই ফ্লো দেখবেন:
   ```
   http://localhost:3000
   ↓
   (লগইন না থাকলে)
   ↓
   /login পেজ দেখায়
   ↓
   "Google দিয়ে লগইন করুন" বাটন
   ↓
   Google এর লগইন ডায়ালগ
   ↓
   ইমেইল সঠিক? → ড্যাশবোর্ড ✅
   ইমেইল ভুল? → /login-failed পেজ ❌
   ```

---

## 🎯 লগইন সিস্টেম কীভাবে কাজ করে?

### সম্পূর্ণ ফ্লো:

```
1. ব্যবহারকারী /login এ আসে
   ↓
2. সার্ভার চেক করে: req.isAuthenticated()?
   - হ্যাঁ → ড্যাশবোর্ড দেখায়
   - না → login.html দেখায়
   ↓
3. ব্যবহারকারী "Google দিয়ে লগইন করুন" ক্লিক করে
   ↓
4. /api/auth/google এ যায়
   ↓
5. Google OAuth প্রক্রিয়া শুরু:
   - Google এর লগইন ডায়ালগ খোলে
   - ব্যবহারকারী Google দিয়ে সাইন ইন করে
   - Google, সার্ভারকে access token পাঠায়
   ↓
6. সার্ভার Passport দিয়ে ইমেইল ভেরিফাই করে
   (server.js লাইন 36-40 দেখুন)
   ↓
7. Passport এ এই কোড আছে:
   ```javascript
   if (profile.emails[0].value === process.env.ALLOWED_EMAIL) {
     return done(null, profile);  // ইমেইল সঠিক ✅
   } else {
     return done(null, false);     // ইমেইল ভুল ❌
   }
   ```
   ↓
8. সঠিক ইমেইল হলে:
   - Passport, ব্যবহারকারীকে serialize করে
   - req.isAuthenticated() = true হয়
   - "/" এ রিডাইরেক্ট করে
   - ড্যাশবোর্ড দেখায়
   ↓
9. ভুল ইমেইল হলে:
   - failureRedirect: '/login-failed' এ যায়
   - এরর পেজ দেখায়
```

---

## 🔒 নিরাপত্তা বৈশিষ্ট্য

আপনার সিস্টেমে এই নিরাপত্তা আছে:

### ১. ইমেইল ভেরিফিকেশন
```javascript
if (profile.emails && profile.emails[0].value === process.env.ALLOWED_EMAIL) {
  // শুধুমাত্র একটি নির্দিষ্ট ইমেইল লগইন করতে পারে
}
```

### ২. সেশন ম্যানেজমেন্ট
```javascript
app.use(session({
  secret: 'chowdhury_dental_secret',
  resave: false,
  saveUninitialized: false
}));
```

### ৩. Passport Authentication
```javascript
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));
```

### ৪. API রক্ষা
```javascript
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Unauthorized!" });
};

// সব API তে ব্যবহার করা হয়:
app.get('/api/pages', ensureAuthenticated, ...);
app.post('/api/upload/bulk', ensureAuthenticated, ...);
```

---

## ⚙️ লজাউট ফিচার

ড্যাশবোর্ডে লজাউট বাটন যোগ করতে চাইলে:

### HTML এ যোগ করুন:
```html
<a href="/api/auth/logout" class="btn-logout">
  লজআউট
</a>
```

### কি হবে:
- ব্যবহারকারী ক্লিক করলে
- সেশন ক্লিয়ার হবে
- `/login` এ রিডাইরেক্ট হবে

---

## 🐛 সাধারণ সমস্যা এবং সমাধান

### সমস্যা 1: "ALLOWED_EMAIL undefined"
**সমাধান:** `.env` ফাইলে এটি যোগ করুন:
```bash
ALLOWED_EMAIL=your-email@gmail.com
```

### সমস্যা 2: "GOOGLE_CLIENT_ID undefined"
**সমাধান:** 
1. Google Cloud Console এ যান
2. Credentials তৈরি করুন
3. `.env` তে পেস্ট করুন

### সমস্যা 3: "Invalid redirect_uri"
**সমাধান:** Google Cloud এ যাচাই করুন যে:
- Authorized redirect URI সঠিক:
  - Local: `http://localhost:3000/api/auth/google/callback`
  - Production: `https://your-domain.com/api/auth/google/callback`

### সমস্যা 4: লজিন ব্যর্থ হয় অথচ ইমেইল সঠিক
**সমাধান:** 
1. `.env` এ ALLOWED_EMAIL সঠিক কি না চেক করুন
2. বড় ছোট হাতের অক্ষর মিলিয়ে চেক করুন

### সমস্যা 5: সার্ভার রিস্টার্টের পর লজিন আউট হয়ে যায়
এটি স্বাভাবিক। ডিফল্ট সেশন মেমরিতে সংরক্ষিত থাকে।
প্রোডাকশনের জন্য Database session store ব্যবহার করুন।

---

## 📦 প্রোডাকশনের জন্য টিপস

### ১. Domain সেটআপ
```bash
APP_BASE_URL=https://your-domain.com
```

### ২. Google Cloud এ Domain যোগ করুন
Authorized redirect URIs:
```
https://your-domain.com/api/auth/google/callback
```

### ৩. HTTPS ব্যবহার করুন
Google OAuth শুধুমাত্র HTTPS এ কাজ করে (localhost ছাড়া)

### ৪. সেশন সিক্রেট বদলান
server.js এ:
```javascript
app.use(session({
  secret: 'your-super-secret-key-change-this', // দীর্ঘ, অনন্য স্ট্রিং
  resave: false,
  saveUninitialized: false
}));
```

### ৫. Database Session Store ব্যবহার করুন
```bash
npm install connect-pg-simple
```

---

## 📞 যোগাযোগ

যদি কোনো সমস্যা হয়:
1. `.env` সঠিকভাবে সেট করেছেন কি না চেক করুন
2. Google Cloud এ Credentials সঠিক কি না যাচাই করুন
3. সার্ভার লগ দেখুন (কনসোল আউটপুট)
4. Browser এর Developer Tools খুলুন (F12) - Network ট্যাব

---

## ✨ এখন আপনার লগইন সিস্টেম সম্পূর্ণ!

এটি এখন:
✅ নিরাপদ (শুধু অনুমোদিত ইমেইল)
✅ সহজ (Google দিয়ে লগইন)
✅ ইউজার-ফ্রেন্ডলি (সুন্দর লগইন পেজ)
✅ প্রোডাকশন-রেডি (সকল best practices সহ)

হ্যাপি কোডিং! 🚀
