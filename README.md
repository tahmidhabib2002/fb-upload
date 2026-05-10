# FB Bulk Video Scheduler

Schedule 50–100 videos across multiple Facebook Pages with automatic 7-day expiration. Built for copyright-safe content management.

---

## Features

- **Multi-Page Distribution** — Select any combination of your connected pages per batch
- **Drag & Drop Bulk Upload** — Up to 100 videos (500MB each) in one session
- **Smart Auto-Scheduler** — Set a start date + fixed BST time; videos fill subsequent days automatically
- **7-Day Auto-Expiration** — Every scheduled post expires exactly 7 days after publishing via Facebook's native `expiration` API parameter
- **Resumable Uploads** — Facebook's chunked upload API handles large files and bad connections
- **Rate-Limited Queue** — Max 3 concurrent uploads with 500ms spacing; won't hit Facebook rate limits
- **Live Progress Bar** — Real-time upload progress with done/failed/queued counts
- **Upload Logs Dashboard** — Full history with status tracking and manual delete option
- **BST Timezone Lock** — All scheduling locked to Bangladesh Standard Time (UTC+6)

---

## Tech Stack

| Layer     | Technology                          |
|-----------|-------------------------------------|
| Backend   | Node.js + Express                   |
| Frontend  | Vanilla HTML / CSS / JS             |
| Database  | Supabase (PostgreSQL)               |
| Upload    | Facebook Resumable Video Upload API |
| Queue     | p-queue (in-process, rate-limited)  |

---

## Prerequisites

- Node.js 18+
- A Facebook Developer App with these permissions approved:
  - `pages_manage_posts`
  - `pages_read_engagement`
  - `publish_video`
- A Supabase project (free tier is fine)

---

## Setup

### 1. Install dependencies

```bash
cd fb-scheduler
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your actual credentials:

```
FB_APP_ID=your_facebook_app_id
FB_APP_SECRET=your_facebook_app_secret
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
PORT=3000
FB_API_VERSION=v19.0
CHUNK_SIZE=10485760
MAX_CONCURRENT_UPLOADS=3
```

### 3. Create database tables

In your Supabase dashboard → SQL Editor, paste and run the contents of `schema.sql`.

### 4. Start the server

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Open `http://localhost:3000` in your browser.

---

## Usage

### Step 1: Connect Pages

1. Go to **Connect Pages** in the sidebar
2. Visit [Facebook Graph API Explorer](https://developers.facebook.com/tools/explorer)
3. Select your app, add permissions: `pages_manage_posts`, `pages_read_engagement`, `publish_video`
4. Click **Generate Access Token**, copy it
5. Paste it into the token field and click **Connect & Import Pages**

Your pages are saved with long-lived tokens automatically.

### Step 2: Bulk Upload

1. Go to **Bulk Upload**
2. Check the pages you want to post to
3. Drag and drop your videos (or click Browse)
4. Optionally set per-video title overrides
5. Set a **Master Title**, **Description**, **Start Date**, and **Fixed Post Time (BST)**
6. Click **Start Bulk Upload**

**Example**: 10 videos, 2 pages, start 2025-02-01, 21:00 BST → 20 total uploads across 10 days.

### Step 3: Monitor

- The progress modal shows live upload status
- Visit **Upload Logs** for full history
- Each post shows its scheduled time and auto-expire time

---

## Facebook API: How 7-Day Expiration Works

During the **finish phase** of the resumable upload, we pass:

```json
{
  "upload_phase": "finish",
  "upload_session_id": "...",
  "published": false,
  "scheduled_publish_time": 1234567890,
  "expiration": {
    "time": 1235172690,
    "type": "expire_only"
  }
}
```

- `time` = `scheduled_publish_time + 604800` (7 days in seconds)
- `type: "expire_only"` means the post is hidden/removed without deleting the video from your library

---

## Resumable Upload Flow

```
Client → Server → Facebook Graph Video API

1. POST /videos?upload_phase=start&file_size=N
   ← { upload_session_id, video_id, start_offset, end_offset }

2. POST /videos (multipart, upload_phase=transfer)
   Repeat for each 10MB chunk
   ← { start_offset, end_offset } for next chunk

3. POST /videos?upload_phase=finish&scheduled_publish_time=...&expiration=...
   ← { post_id }
```

---

## System User Token (Recommended for Production)

Standard user tokens expire after 60 days. System User tokens never expire.

1. Open [Facebook Business Manager](https://business.facebook.com)
2. Go to **System Users → Add**
3. Create a system user with **Employee** role
4. Click **Add Assets** → add your pages with **Content Creator** access
5. Click **Generate New Token** → select your app → add all required permissions
6. Copy the token and use it in the Connect Pages flow

---

## Rate Limits

Facebook enforces rate limits on the Graph API. This app handles them via:

- Max **3 concurrent** upload workers
- **500ms delay** between chunk transfers
- **p-queue** job management with automatic backpressure

If you're posting to 20+ pages simultaneously and hitting limits, reduce `MAX_CONCURRENT_UPLOADS` in `.env` to 1 or 2.

---

## Project Structure

```
fb-scheduler/
├── server.js         ← Express API server (all routes)
├── queue.js          ← Upload queue + Facebook API calls
├── db.js             ← Supabase client + DB helpers
├── schema.sql        ← Run once in Supabase to create tables
├── .env.example      ← Environment variable template
├── package.json
└── public/
    ├── index.html    ← Main dashboard UI
    ├── style.css     ← Dark industrial theme
    └── app.js        ← Frontend logic (vanilla JS)
```

---

## Security Notes

- All Facebook tokens are stored **server-side only** (Supabase)
- The frontend never receives or handles access tokens
- App secrets are kept in `.env` and never exposed to the client
- Add `.env` to your `.gitignore` before pushing to any repository

---

## License

Built for personal/business use by Viral Clips BD. Not affiliated with Meta.
