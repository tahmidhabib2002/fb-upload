// queue.js — Upload queue manager with rate limiting
require('dotenv').config();
const { default: PQueue } = require('p-queue');
const axios = require('axios');
const FormData = require('form-data');
const { updateUploadLog } = require('./db');

const FB_API_VERSION = process.env.FB_API_VERSION || 'v19.0';
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 10 * 1024 * 1024; // 10MB
const FB_GRAPH_URL = `https://graph.facebook.com/${FB_API_VERSION}`;
const FB_GRAPH_VIDEO_URL = `https://graph-video.facebook.com/${FB_API_VERSION}`;

// Queue: max 3 concurrent uploads, 500ms interval between requests
const uploadQueue = new PQueue({
  concurrency: parseInt(process.env.MAX_CONCURRENT_UPLOADS) || 2,
  interval: 1000,
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
// EXCHANGE short-lived token → long-lived token
// ─────────────────────────────────────────────
async function exchangeForLongLivedToken(shortLivedToken) {
  const clientId = process.env.FB_APP_ID;
  const clientSecret = process.env.FB_APP_SECRET;

  if (!shortLivedToken) {
    throw new Error("Short-lived token পাওয়া যায়নি!");
  }

  console.log('[FB] Exchanging token for long-lived...');
  
  const res = await axios.get('https://graph.facebook.com/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: clientId,
      client_secret: clientSecret,
      fb_exchange_token: shortLivedToken
    }
  });
  
  console.log('[FB] Token exchange successful');
  return res.data; 
}

// ─────────────────────────────────────────────
// FETCH pages from a user token
// ─────────────────────────────────────────────
async function fetchUserPages(userAccessToken) {
  console.log('[FB] Fetching user pages...');
  
  const res = await axios.get(`${FB_GRAPH_URL}/me/accounts`, {
    params: {
      access_token: userAccessToken,
      fields: 'id,name,access_token,picture,category'
    }
  });
  
  console.log(`[FB] Found ${res.data.data?.length || 0} pages`);
  return res.data.data || [];
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

  return res.data;
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
    { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 60000 }
  );

  return res.data;
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
    published: 'false'
  });

  // Add scheduled publish time (Unix timestamp)
  const scheduledUnix = Math.floor(new Date(scheduledTime).getTime() / 1000);
  params.append('scheduled_publish_time', scheduledUnix.toString());

  // Add expiration (7 days after scheduled publish time)
  const expireUnix = Math.floor(new Date(expireTime).getTime() / 1000);
  params.append('expiration', JSON.stringify({
    time: expireUnix,
    type: 'expire_only'
  }));

  console.log(`[FB] Scheduling video for ${new Date(scheduledTime).toISOString()}, expires at ${new Date(expireTime).toISOString()}`);

  const res = await axios.post(
    `${FB_GRAPH_VIDEO_URL}/${pageId}/videos`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
  );

  return res.data;
}

// ─────────────────────────────────────────────
// MAIN: Enqueue a single video upload job
// ─────────────────────────────────────────────
function enqueueUpload({ jobId, batchId, logId, pageId, accessToken, fileBuffer, videoMeta }) {
  // Register/update batch progress
  if (!activeJobs.has(batchId)) {
    activeJobs.set(batchId, { total: 0, done: 0, failed: 0, status: 'running' });
  }
  const batch = activeJobs.get(batchId);
  batch.total += 1;

  uploadQueue.add(async () => {
    try {
      console.log(`[Queue] Starting upload for log ${logId} to page ${pageId}`);
      
      // Update DB: uploading
      await updateUploadLog(logId, { status: 'uploading' });

      const fileSize = fileBuffer.length;
      console.log(`[Queue] File size: ${fileSize} bytes`);

      // Phase 1: Start resumable upload session
      const startRes = await startResumableUpload(pageId, accessToken, fileSize);
      const { upload_session_id, video_id } = startRes;
      let { start_offset, end_offset } = startRes;
      
      console.log(`[Queue] Upload session started: ${upload_session_id}`);

      // Phase 2: Transfer all chunks
      let transferred = 0;
      let chunkCount = 0;
      
      while (parseInt(start_offset) < fileSize) {
        const chunkEnd = Math.min(parseInt(end_offset), fileSize);
        const chunk = fileBuffer.slice(parseInt(start_offset), chunkEnd);
        
        console.log(`[Queue] Transferring chunk ${++chunkCount}: ${start_offset} to ${chunkEnd}`);
        
        const transferRes = await transferChunk({
          pageId, accessToken,
          uploadSessionId: upload_session_id,
          chunk,
          startOffset: start_offset,
          endOffset: end_offset
        });

        transferred += chunk.length;
        start_offset = transferRes.start_offset;
        end_offset = transferRes.end_offset;

        // Small delay between chunks to be gentle on rate limits
        await new Promise(r => setTimeout(r, 300));
      }
      
      console.log(`[Queue] All ${chunkCount} chunks transferred successfully`);

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
        post_id: finishRes.id || null,
        video_id: video_id || null
      });

      console.log(`[Queue] Upload complete for log ${logId}, post_id: ${finishRes.id}`);

      // Update batch progress
      batch.done += 1;
      if (batch.done + batch.failed >= batch.total) {
        batch.status = batch.failed > 0 ? 'partial' : 'complete';
      }

    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
      console.error(`[Queue] Upload failed for log ${logId}:`, errMsg);
      console.error(`[Queue] Full error:`, err.response?.data || err);

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
    `${FB_GRAPH_URL}/${postId}`,
    { params: { access_token: accessToken } }
  );
  return res.data;
}

module.exports = {
  enqueueUpload,
  getQueueStatus,
  deleteVideoPost,
  exchangeForLongLivedToken,
  fetchUserPages,
  activeJobs
};
