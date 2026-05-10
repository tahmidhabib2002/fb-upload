# দ্রুত সেটআপ চেকলিস্ট ✅

## ১. Google OAuth সেটআপ করুন

### Google Cloud Console এ:
- [ ] নতুন প্রজেক্ট তৈরি করুন
- [ ] Google+ API enable করুন
- [ ] OAuth 2.0 Credentials তৈরি করুন
- [ ] Authorized redirect URI যোগ করুন:
  ```
  http://localhost:3000/api/auth/google/callback
  ```
- [ ] Client ID কপি করুন
- [ ] Client Secret কপি করুন

---

## ২. .env ফাইল সেটআপ করুন

আপনার প্রজেক্ট রুট এ `.env` ফাইল তৈরি করুন:

```bash
# Google OAuth Credentials
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID_HERE
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE

# শুধি এই ইমেইল লগইন করতে পারবে
ALLOWED_EMAIL=your-email@gmail.com

# Facebook
FB_APP_ID=1763519494612035
FB_APP_SECRET=a4f78191ae500a25a228f3607217a228

# Supabase
SUPABASE_URL=https://vinlrfcbohsrvumoidbj.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_bsLAsH0xiIyXmJtFkw8bCg_7PWpMKgr

# Server
PORT=3000
NODE_ENV=development
APP_BASE_URL=http://localhost:3000
FB_API_VERSION=v19.0
CHUNK_SIZE=10485760
MAX_CONCURRENT_UPLOADS=3
```

---

## ৩. ফাইল আপডেট/তৈরি করুন

### পুরাতন ফাইল আপডেট করুন:
- [ ] `server.js` - নতুন ভার্সন দিয়ে প্রতিস্থাপন করুন

### নতুন ফাইল তৈরি করুন:
- [ ] `public/login.html` - লগইন পেজ
- [ ] `public/login-failed.html` - এরর পেজ
- [ ] `.env` - পরিবেশ ভ্যারিয়েবল

---

## ৪. পরীক্ষা করুন

```bash
# সার্ভার রিস্টার্ট করুন
npm start

# ব্রাউজার খুলুন
http://localhost:3000
```

### যা ঘটবে:
1. `/login` পেজ দেখাবে ✅
2. "Google দিয়ে লগইন করুন" বাটন দেখাবে ✅
3. ক্লিক করলে Google এর লগইন ডায়ালগ খুলবে ✅
4. সঠিক ইমেইল হলে ড্যাশবোর্ডে যাবে ✅
5. ভুল ইমেইল হলে এরর পেজ দেখাবে ✅

---

## 📋 প্রয়োজনীয় npm প্যাকেজ

সব প্যাকেজ আগে থেকে আছে কি না চেক করুন:

```bash
npm list passport
npm list passport-google-oauth20
npm list express-session
npm list express
```

যদি কোনো missing থাকে:
```bash
npm install passport passport-google-oauth20 express-session
```

---

## 🎯 কাজের ফ্লো

```
ব্যবহারকারী
    ↓
http://localhost:3000 খোলে
    ↓
সার্ভার চেক করে: লগিন আছে?
    ↓
না → /login পেজ দেখায়
    ↓
ব্যবহারকারী Google বাটন ক্লিক করে
    ↓
Google এ লগইন করে
    ↓
সার্ভার ইমেইল ভেরিফাই করে
    ↓
সঠিক ইমেইল → ড্যাশবোর্ড দেখায় ✅
ভুল ইমেইল → এরর পেজ দেখায় ❌
```

---

## 🔍 Troubleshooting

### লগইন পেজ দেখা যায় না?
```
সমাধান:
1. public/login.html ফাইল আছে কি?
2. সার্ভার রিস্টার্ট করেছেন?
3. ব্রাউজার refresh করেছেন? (Ctrl+Shift+R)
```

### "Google দিয়ে লগইন করুন" বাটন কাজ করে না?
```
সমাধান:
1. .env এ GOOGLE_CLIENT_ID সেট আছে?
2. .env এ GOOGLE_CLIENT_SECRET সেট আছে?
3. Google Cloud এ redirect URI সঠিক?
   → http://localhost:3000/api/auth/google/callback
```

### লজিন করে এরর পেজ দেখায়?
```
সমাধান:
1. .env এ ALLOWED_EMAIL সঠিক?
2. ইমেইল small/uppercase মেলে?
   (example@gmail.com ≠ Example@Gmail.com)
3. Google এ যে ইমেইল ব্যবহার করেছেন সেটা ALLOWED_EMAIL এ আছে?
```

### সার্ভার কনসোল এ কোনো error দেখা যায়?
```
সমাধান:
1. সম্পূর্ণ error message পড়ুন
2. .env এর ভ্যারিয়েবল সব সেট আছে কি?
3. সার্ভার লগ দেখুন (node console output)
```

---

## 🚀 প্রোডাকশনের জন্য

যখন আপনার নিজস্ব ডোমেইন থাকবে:

1. **Google Cloud এ Domain যোগ করুন:**
   ```
   https://your-domain.com/api/auth/google/callback
   ```

2. **.env আপডেট করুন:**
   ```bash
   APP_BASE_URL=https://your-domain.com
   ALLOWED_EMAIL=your-email@your-domain.com
   NODE_ENV=production
   ```

3. **HTTPS সেটআপ করুন**
   Google OAuth এ HTTPS প্রয়োজন!

---

## 📞 সাপোর্ট

যদি কোনো সমস্যা হয়:

1. **Browser Console খুলুন** (F12 → Console tab)
2. **Network tab চেক করুন** - কি error দেখা যাচ্ছে?
3. **সার্ভার লগ দেখুন** - node console এ কি লিখা আছে?
4. **এই ফাইল রিপড়ুন:** `LOGIN_SYSTEM_GUIDE_BN.md`

---

## ✨ আপনার সিস্টেম সম্পূর্ণ!

এখন আপনার কাছে আছে:
- ✅ নিরাপদ লগইন সিস্টেম
- ✅ Google OAuth integration
- ✅ ইমেইল ভেরিফিকেশন
- ✅ সুন্দর UI
- ✅ এরর হ্যান্ডলিং

Happy coding! 🎉
