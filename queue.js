// queue.js — Upload queue manager with rate limiting
// Uses p-queue to prevent hitting Facebook's rate limits
require('dotenv').config();
const { default: PQueue } = require('p-queue');
const axios = require('axios');
const FormData = require('form-data');
const { updateUploadLog, updateUploadSession } = require('./db');

const FB_API_VERSION = process.env.FB_API_VERSION || 'v19.0';
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 10 * 1024 * 1024; // 10MB
const FB_GRAPH_VIDEO_URL = `https://graph-video.facebook.com/${FB_API_VERSION}`;

// Queue: max 3 concurrent uploads, 1 request per 500ms interval
const uploadQueue = new PQueue({
  concurrency: parseInt(process.env.MAX_CONCURRENT_UPLOADS) || 3,
  interval: 500,
  intervalCap: 1
});

// Track active jobs for the progress system
const activeJobs = new Map(); // jobId → { total, done, failed, status }

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
    file_size: fileSize,
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
async function transferChunk({ pageId, accessToken, uploadSessionId, chunk, startOffset, endOffset }) {
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
    { headers: form.getHeaders(), maxBodyLength: Infinity }
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
  const params = new URLSearchParams({
    upload_phase: 'finish',
    upload_session_id: uploadSessionId,
    access_token: accessToken,
    title: title || '',
    description: description || '',
    published: 'false',
    scheduled_publish_time: Math.floor(new Date(scheduledTime).getTime() / 1000).toString()
  });

  // Add expiration (7 days after scheduled publish time)
  const expireUnix = Math.floor(new Date(expireTime).getTime() / 1000);
  params.append('expiration', JSON.stringify({
    time: expireUnix,
    type: 'expire_only'
  }));

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
  // Register in active jobs tracker
  if (!activeJobs.has(batchId)) {
    activeJobs.set(batchId, { total: 0, done: 0, failed: 0, status: 'running' });
  }
  const batch = activeJobs.get(batchId);
  batch.total += 1;

  uploadQueue.add(async () => {
    try {
      // Update DB: uploading
      await updateUploadLog(logId, { status: 'uploading' });

      const fileSize = fileBuffer.length;

      // Phase 1: Start
      const startRes = await startResumableUpload(pageId, accessToken, fileSize);
      const { upload_session_id, video_id } = startRes;
      let { start_offset, end_offset } = startRes;

      // Phase 2: Transfer all chunks
      let transferred = 0;
      while (start_offset < fileSize) {
        const chunkEnd = Math.min(parseInt(end_offset), fileSize);
        const chunk = fileBuffer.slice(parseInt(start_offset), chunkEnd);

        const transferRes = await transferChunk({
          pageId, accessToken,
          uploadSessionId: upload_session_id,
          chunk,
          startOffset: start_offset,
          endOffset: end_offset
        });

        transferred += chunk.length;
        start_offset = parseInt(transferRes.start_offset);
        end_offset = parseInt(transferRes.end_offset);

        // Small delay between chunks to be gentle on rate limits
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

      // Update DB: scheduled ✅
      await updateUploadLog(logId, {
        status: 'scheduled',
        post_id: finishRes.post_id || null,
        video_id: video_id || null
      });

      batch.done += 1;
      if (batch.done + batch.failed >= batch.total) {
        batch.status = batch.failed > 0 ? 'partial' : 'complete';
      }

    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
      console.error(`[Queue] Upload failed for log ${logId}:`, errMsg);

      await updateUploadLog(logId, {
        status: 'failed',
        error_message: errMsg
      });

      const batch = activeJobs.get(batchId);
      if (batch) {
        batch.failed += 1;
        if (batch.done + batch.failed >= batch.total) {
          batch.status = 'partial';
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
  const res = await axios.get('https://graph.facebook.com/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.FB_APP_ID,
      client_secret: process.env.FB_APP_SECRET,
      fb_exchange_token: shortLivedToken
    }
  });
  return res.data; // { access_token, token_type, expires_in }
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
