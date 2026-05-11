// queue.js — Upload queue manager with rate limiting (FIXED v2.0)
// FIX 1: Facebook expiration field sent correctly
// FIX 2: scheduled_publish_time validation
// FIX 3: Better error logging

require('dotenv').config();
const { default: PQueue } = require('p-queue');
const axios = require('axios');
const FormData = require('form-data');
const { updateUploadLog } = require('./db');

const FB_API_VERSION = process.env.FB_API_VERSION || 'v19.0';
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 10 * 1024 * 1024; // 10MB
const FB_GRAPH_VIDEO_URL = `https://graph-video.facebook.com/${FB_API_VERSION}`;

// Queue: max 3 concurrent uploads
const uploadQueue = new PQueue({
  concurrency: parseInt(process.env.MAX_CONCURRENT_UPLOADS) || 3,
  interval: 500,
  intervalCap: 1
});

// Track active jobs for the progress system
const activeJobs = new Map(); // batchId → { total, done, failed, status }

function getQueueStatus() {
  return {
    pending: uploadQueue.size,
    active: uploadQueue.pending,
    jobs: Object.fromEntries(activeJobs)
  };
}

// ─────────────────────────────────────────────
// RESUMABLE UPLOAD — Phase 1: Start
// ─────────────────────────────────────────────
async function startResumableUpload(pageId, accessToken, fileSize) {
  const params = new URLSearchParams({
    upload_phase: 'start',
    file_size: fileSize.toString(),
    access_token: accessToken
  });

  const res = await axios.post(
    `${FB_GRAPH_VIDEO_URL}/${pageId}/videos`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data; // { upload_session_id, video_id, start_offset, end_offset }
}

// ─────────────────────────────────────────────
// RESUMABLE UPLOAD — Phase 2: Transfer Chunks
// ─────────────────────────────────────────────
async function transferChunk({ pageId, accessToken, uploadSessionId, chunk, startOffset }) {
  const form = new FormData();
  form.append('upload_phase', 'transfer');
  form.append('upload_session_id', uploadSessionId);
  form.append('start_offset', startOffset.toString());
  form.append('access_token', accessToken);
  form.append('video_file_chunk', chunk, {
    filename: 'chunk',
    contentType: 'application/octet-stream',
    knownLength: chunk.length
  });

  const res = await axios.post(
    `${FB_GRAPH_VIDEO_URL}/${pageId}/videos`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
  );

  return res.data; // { start_offset, end_offset } for next chunk
}

// ─────────────────────────────────────────────
// RESUMABLE UPLOAD — Phase 3: Finish & Schedule
// ─────────────────────────────────────────────
async function finishUpload({
  pageId, accessToken, uploadSessionId,
  title, description,
  scheduledTime, expireTime
}) {
  // Convert ISO strings → Unix timestamps
  const scheduledUnix = Math.floor(new Date(scheduledTime).getTime() / 1000);
  const expireUnix = Math.floor(new Date(expireTime).getTime() / 1000);

  // Validate: scheduled must be >10 min from now
  const nowUnix = Math.floor(Date.now() / 1000);
  if (scheduledUnix < nowUnix + 600) {
    throw new Error(`Scheduled time (${scheduledTime}) is less than 10 minutes from now. Facebook rejects this.`);
  }

  const params = new URLSearchParams({
    upload_phase: 'finish',
    upload_session_id: uploadSessionId,
    access_token: accessToken,
    title: title || '',
    description: description || '',
    published: 'false',
    scheduled_publish_time: scheduledUnix.toString()
  });

  // ── FIX: Facebook expiration must be sent as form field, not JSON ──
  // The 'expiration' parameter for videos uses Unix timestamp
  // Note: Not all Facebook API versions support this — it may be silently ignored
  params.append('expiration_time', expireUnix.toString());

  const res = await axios.post(
    `${FB_GRAPH_VIDEO_URL}/${pageId}/videos`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data; // { id, post_id, ... }
}

// ─────────────────────────────────────────────
// MAIN: Enqueue a single video upload job
// ─────────────────────────────────────────────
function enqueueUpload({ jobId, batchId, logId, pageId, accessToken, fileBuffer, videoMeta }) {
  if (!activeJobs.has(batchId)) {
    activeJobs.set(batchId, { total: 0, done: 0, failed: 0, status: 'running' });
  }
  const batch = activeJobs.get(batchId);
  batch.total += 1;

  uploadQueue.add(async () => {
    try {
      await updateUploadLog(logId, { status: 'uploading' });

      const fileSize = fileBuffer.length;

      // Phase 1: Start
      const startRes = await startResumableUpload(pageId, accessToken, fileSize);
      const { upload_session_id, video_id } = startRes;
      let startOffset = parseInt(startRes.start_offset);
      let endOffset = parseInt(startRes.end_offset);

      // Phase 2: Transfer all chunks
      while (startOffset < fileSize) {
        const chunkEnd = Math.min(endOffset, fileSize);
        const chunk = fileBuffer.slice(startOffset, chunkEnd);

        const transferRes = await transferChunk({
          pageId, accessToken,
          uploadSessionId: upload_session_id,
          chunk,
          startOffset
        });

        startOffset = parseInt(transferRes.start_offset);
        endOffset = parseInt(transferRes.end_offset);

        // Small delay between chunks
        await new Promise(r => setTimeout(r, 200));
      }

      // Phase 3: Finish & Schedule
      const finishRes = await finishUpload({
        pageId, accessToken,
        uploadSessionId: upload_session_id,
        title: videoMeta.title,
        description: videoMeta.description,
        scheduledTime: videoMeta.scheduledTime,
        expireTime: videoMeta.expireTime
      });

      await updateUploadLog(logId, {
        status: 'scheduled',
        post_id: finishRes.post_id || finishRes.id || null,
        video_id: video_id || null
      });

      const batchRef = activeJobs.get(batchId);
      if (batchRef) {
        batchRef.done += 1;
        if (batchRef.done + batchRef.failed >= batchRef.total) {
          batchRef.status = batchRef.failed > 0 ? 'partial' : 'complete';
        }
      }

    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
      console.error(`[Queue] Upload failed for log ${logId}:`, errMsg);

      await updateUploadLog(logId, {
        status: 'failed',
        error_message: errMsg
      });

      const batchRef = activeJobs.get(batchId);
      if (batchRef) {
        batchRef.failed += 1;
        if (batchRef.done + batchRef.failed >= batchRef.total) {
          batchRef.status = batchRef.failed > 0 ? 'partial' : 'complete';
        }
      }
    }
  });
}

// ─────────────────────────────────────────────
// DELETE a video post from Facebook
// ─────────────────────────────────────────────
async function deleteVideoPost(postId, accessToken) {
  const res = await axios.delete(
    `https://graph.facebook.com/${FB_API_VERSION}/${postId}`,
    { params: { access_token: accessToken } }
  );
  return res.data;
}

// ─────────────────────────────────────────────
// EXCHANGE short-lived token → long-lived token
// ─────────────────────────────────────────────
async function exchangeForLongLivedToken(shortLivedToken) {
  const clientId = process.env.FB_APP_ID;
  const clientSecret = process.env.FB_APP_SECRET;

  if (!shortLivedToken) throw new Error('Short-lived token পাওয়া যায়নি!');
  if (!clientId || !clientSecret) throw new Error('FB_APP_ID or FB_APP_SECRET not configured on server');

  const res = await axios.get('https://graph.facebook.com/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: clientId,
      client_secret: clientSecret,
      fb_exchange_token: shortLivedToken
    }
  });
  return res.data;
}

// ─────────────────────────────────────────────
// FETCH pages from a user token
// ─────────────────────────────────────────────
async function fetchUserPages(userAccessToken) {
  const res = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/me/accounts`, {
    params: {
      access_token: userAccessToken,
      fields: 'id,name,access_token,picture,category'
    }
  });
  return res.data.data || [];
}

module.exports = {
  enqueueUpload,
  getQueueStatus,
  deleteVideoPost,
  exchangeForLongLivedToken,
  fetchUserPages,
  activeJobs
};
