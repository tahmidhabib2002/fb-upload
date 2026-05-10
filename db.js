// db.js — Supabase client & all database helpers
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.warn('[db] WARNING: SUPABASE_URL or SUPABASE_SERVICE_KEY not set. Database operations will fail.');
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder-key'
);

// ─────────────────────────────────────────────
// SCHEMA (run once in Supabase SQL editor)
// ─────────────────────────────────────────────
// CREATE TABLE pages (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   page_id TEXT NOT NULL UNIQUE,
//   page_name TEXT NOT NULL,
//   access_token TEXT NOT NULL,
//   picture_url TEXT,
//   category TEXT,
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// CREATE TABLE upload_logs (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   post_id TEXT,
//   video_id TEXT,
//   video_title TEXT,
//   page_id TEXT NOT NULL,
//   page_name TEXT,
//   scheduled_time TIMESTAMPTZ,
//   expire_time TIMESTAMPTZ,
//   status TEXT DEFAULT 'pending',   -- pending | uploading | scheduled | failed | expired
//   error_message TEXT,
//   file_name TEXT,
//   file_size BIGINT,
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// CREATE TABLE upload_sessions (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   session_key TEXT NOT NULL UNIQUE,
//   page_id TEXT NOT NULL,
//   video_title TEXT,
//   description TEXT,
//   scheduled_time TIMESTAMPTZ,
//   expire_time TIMESTAMPTZ,
//   fb_upload_session_id TEXT,
//   fb_video_id TEXT,
//   file_size BIGINT,
//   bytes_transferred BIGINT DEFAULT 0,
//   status TEXT DEFAULT 'init',
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );

// ─────────────────────────────────────────────
// PAGES
// ─────────────────────────────────────────────

async function savePage(pageData) {
  const { data, error } = await supabase
    .from('pages')
    .upsert({
      page_id: pageData.page_id,
      page_name: pageData.page_name,
      access_token: pageData.access_token,
      picture_url: pageData.picture_url || null,
      category: pageData.category || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'page_id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getPages() {
  const { data, error } = await supabase
    .from('pages')
    .select('id, page_id, page_name, picture_url, category, created_at')
    .order('page_name');

  if (error) throw error;
  return data || [];
}

async function getPage(pageId) {
  const { data, error } = await supabase
    .from('pages')
    .select('*')
    .eq('page_id', pageId)
    .single();

  if (error) throw error;
  return data;
}

async function deletePage(pageId) {
  const { error } = await supabase
    .from('pages')
    .delete()
    .eq('page_id', pageId);

  if (error) throw error;
}

// ─────────────────────────────────────────────
// UPLOAD LOGS
// ─────────────────────────────────────────────

async function createUploadLog(logData) {
  const { data, error } = await supabase
    .from('upload_logs')
    .insert({
      video_title: logData.video_title,
      page_id: logData.page_id,
      page_name: logData.page_name,
      scheduled_time: logData.scheduled_time,
      expire_time: logData.expire_time,
      status: 'pending',
      file_name: logData.file_name,
      file_size: logData.file_size
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateUploadLog(id, updates) {
  const { data, error } = await supabase
    .from('upload_logs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getUploadLogs({ page = 1, limit = 50, status, pageId } = {}) {
  let query = supabase
    .from('upload_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status) query = query.eq('status', status);
  if (pageId) query = query.eq('page_id', pageId);

  const { data, error, count } = await query;
  if (error) throw error;
  return { logs: data || [], total: count };
}

async function deleteUploadLog(id) {
  const { error } = await supabase
    .from('upload_logs')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

// ─────────────────────────────────────────────
// UPLOAD SESSIONS (resumable)
// ─────────────────────────────────────────────

async function createUploadSession(sessionData) {
  const { data, error } = await supabase
    .from('upload_sessions')
    .insert(sessionData)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateUploadSession(sessionKey, updates) {
  const { data, error } = await supabase
    .from('upload_sessions')
    .update(updates)
    .eq('session_key', sessionKey)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getUploadSession(sessionKey) {
  const { data, error } = await supabase
    .from('upload_sessions')
    .select('*')
    .eq('session_key', sessionKey)
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  savePage, getPages, getPage, deletePage,
  createUploadLog, updateUploadLog, getUploadLogs, deleteUploadLog,
  createUploadSession, updateUploadSession, getUploadSession
};
