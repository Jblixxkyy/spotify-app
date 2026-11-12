#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const yt = require('./youtube.js');

/* ---------------- Paths ---------------- */

const PORT = parseInt(process.env.PORT || '8378', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DB_PATH = path.join(DATA_DIR, 'myspotify.db');

for (const d of [DATA_DIR, AUDIO_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------- Database ---------------- */

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    pass_hash TEXT,
    name TEXT DEFAULT '',
    provider TEXT DEFAULT '',
    provider_id TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown Artist',
    album TEXT DEFAULT 'Unknown Album',
    art TEXT DEFAULT '',
    duration REAL DEFAULT 0,
    size INTEGER DEFAULT 0,
    hash TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_songs_user ON songs(user_id);
  CREATE INDEX IF NOT EXISTS idx_songs_hash ON songs(user_id, hash);
  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    song_ids TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);
  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    value TEXT DEFAULT '{}',
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS setup (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    code TEXT,
    done INTEGER DEFAULT 0
  );
`);

(function ensureColumns() {
  const cols = new Set(db.prepare('PRAGMA table_info(songs)').all().map((c) => c.name));
  if (!cols.has('source')) db.exec(`ALTER TABLE songs ADD COLUMN source TEXT DEFAULT ''`);
  if (!cols.has('mime')) db.exec(`ALTER TABLE songs ADD COLUMN mime TEXT DEFAULT 'audio/mpeg'`);
  if (!cols.has('replaygain_gain')) db.exec(`ALTER TABLE songs ADD COLUMN replaygain_gain REAL DEFAULT 0`);
  if (!cols.has('replaygain_peak')) db.exec(`ALTER TABLE songs ADD COLUMN replaygain_peak REAL DEFAULT 1`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_songs_source ON songs(user_id, source)`);
})();

/* ---------------- Config (DB-backed, editable from the app) ---------------- */

const SESSION_DAYS = 30;

const ENV_OVERRIDES = {
  google_client_id: process.env.GOOGLE_CLIENT_ID || '',
  google_client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
  github_client_id: process.env.GITHUB_CLIENT_ID || '',
  github_client_secret: process.env.GITHUB_CLIENT_SECRET || '',
  public_origin: process.env.PUBLIC_ORIGIN || '',
};

for (const d of [DATA_DIR, AUDIO_DIR]) fs.mkdirSync(d, { recursive: true });

/* Admin-editable config, persisted in DB (editable from inside the app) */
const CONFIG_DEFAULTS = {
  server_name: '',
  registration_open: true,
  secure_cookies: false,
  max_upload_mb: 500,
  google_client_id: '',
  google_client_secret: '',
  github_client_id: '',
  github_client_secret: '',
  public_origin: '',
};

function loadConfig() {
  const cfg = { ...CONFIG_DEFAULTS };
  const rows = db.prepare('SELECT key, value FROM config').all();
  for (const { key, value } of rows) {
    if (key in cfg) {
      const def = CONFIG_DEFAULTS[key];
      if (typeof def === 'number') cfg[key] = parseInt(value, 10) || def;
      else if (typeof def === 'boolean') cfg[key] = value === 'true';
      else cfg[key] = value;
    }
  }
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    if (v) cfg[k] = v;
  }
  if (!cfg.public_origin) cfg.public_origin = `http://localhost:${PORT}`;
  if (!cfg.max_upload_mb) cfg.max_upload_mb = 500;
  return cfg;
}

let config = loadConfig();

function saveConfig(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in CONFIG_DEFAULTS)) continue;
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(k, String(v));
  }
  config = loadConfig();
}

function publicOrigin() {
  return config.public_origin || `http://localhost:${PORT}`;
}

function oauthProviders() {
  return {
    google: !!(config.google_client_id && config.google_client_secret),
    github: !!(config.github_client_id && config.github_client_secret),
  };
}

function maxUploadBytes() {
  return (config.max_upload_mb || 500) * 1024 * 1024;
}

function secureCookies() {
  return config.secure_cookies === true || config.secure_cookies === 'true';
}

/* ---------------- Helpers ---------------- */

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJsonBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expires);
  let cookie = `mss=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
  if (secureCookies()) cookie += '; Secure';
  res.setHeader('Set-Cookie', cookie);
}

function clearSession(req, res) {
  const token = parseCookies(req).mss;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.setHeader('Set-Cookie', 'mss=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function getUser(req) {
  const token = parseCookies(req).mss;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.provider, u.role, s.expires_at FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, provider: row.provider, role: row.role };
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(pw, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

function sanitizeSong(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    art: row.art || '',
    duration: row.duration,
    size: row.size,
    hash: row.hash,
    source: row.source || '',
    addedAt: row.created_at * 1000,
    url: `/api/songs/${row.id}/audio`,
    replayGain: {
      gainDb: Number(row.replaygain_gain || 0),
      peakDb: Number(row.replaygain_peak || 1),
    },
  };
}

function safeId(id) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''));
}

function cleanText(v, max = 300) {
  return String(v == null ? '' : v).slice(0, max);
}

/* ---------------- OAuth ---------------- */

const oauthStates = new Map(); // state -> {provider, next, expires}

// Where to send the user after OAuth completes. The app lives under a
// subpath on the funnel (/spotify/), but the OAuth callback lands on the
// site root — so "back to /" would drop the user on Theme Maker. Remember
// where they started from (the Referer of the login click) and send them
// back there. Falls back to '/' for direct (non-funnel) access.
function oauthNextPath(req) {
  try {
    const ref = req.headers.referer || req.headers.referrer || '';
    const u = new URL(ref);
    let p = u.pathname || '/';
    if (p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length) || '/';
    if (!p.endsWith('/')) p += '/';
    if (p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/auth/')) return p;
  } catch {}
  return '/';
}

function oauthSafeNext(next) {
  return (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) ? next : '/';
}

// One retry on network-level failures — a single dropped hop to Google
// shouldn't kill a sign-in mid-callback.
async function fetchRetry(url, opts, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetch(url, opts); }
    catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw lastErr;
}

function beginOAuth(provider, redirectUri, res, next) {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider, next: oauthSafeNext(next), expires: Date.now() + 10 * 60 * 1000 });
  let url;
  if (provider === 'google') {
    url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: config.google_client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/youtube.readonly',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
  } else {
    url = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
      client_id: config.github_client_id,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
    });
  }
  res.writeHead(302, { Location: url });
  res.end();
}

async function finishOAuth(provider, code, redirectUri) {
  if (provider === 'google') {
    const tokenRes = await fetchRetry('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google_client_id,
        client_secret: config.google_client_secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!token.access_token) {
      throw new Error('Google token exchange failed' + (token.error_description ? `: ${token.error_description}` : ''));
    }
    const infoRes = await fetchRetry('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const info = await infoRes.json();
    if (!info.email || !info.email_verified) throw new Error('Google email not verified');
    return {
      provider: 'google', providerId: String(info.sub), email: info.email, name: info.name || info.email,
      tokens: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        expiresAt: Math.floor(Date.now() / 1000) + (Number(token.expires_in) || 3600),
      },
    };
  }
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.github_client_id,
      client_secret: config.github_client_secret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) throw new Error('GitHub token exchange failed');
  const headers = { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'MySpotify' };
  const userRes = await fetch('https://api.github.com/user', { headers });
  const user = await userRes.json();
  let email = user.email;
  if (!email) {
    const emailRes = await fetch('https://api.github.com/user/emails', { headers });
    if (emailRes.ok) {
      const emails = await emailRes.json();
      const primary = Array.isArray(emails) && emails.find((e) => e.primary && e.verified);
      if (primary) email = primary.email;
    }
  }
  if (!email) throw new Error('GitHub account has no verified email');
  return { provider: 'github', providerId: String(user.id), email, name: user.name || user.login };
}

function upsertOAuthUser({ provider, providerId, email, name }) {
  const byProvider = db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?').get(provider, providerId);
  if (byProvider) return byProvider.id;
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (byEmail) {
    db.prepare('UPDATE users SET provider = ?, provider_id = ? WHERE id = ?').run(provider, providerId, byEmail.id);
    return byEmail.id;
  }
  const info = db.prepare('INSERT INTO users (email, name, provider, provider_id) VALUES (?, ?, ?, ?)').run(email, name || email, provider, providerId);
  return Number(info.lastInsertRowid);
}

/* -------- Google / YouTube API (per-user tokens from the Google login) ------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS google_tokens (
    user_id INTEGER PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER DEFAULT 0
  );
`);

function storeGoogleTokens(userId, tokens) {
  if (!tokens || !tokens.accessToken) return;
  const prev = db.prepare('SELECT refresh_token FROM google_tokens WHERE user_id = ?').get(userId);
  db.prepare(`
    INSERT INTO google_tokens (user_id, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET access_token = excluded.access_token,
      refresh_token = excluded.refresh_token, expires_at = excluded.expires_at
  `).run(userId, tokens.accessToken, tokens.refreshToken || (prev && prev.refresh_token) || null, tokens.expiresAt || 0);
}

async function googleAccessToken(userId) {
  const row = db.prepare('SELECT * FROM google_tokens WHERE user_id = ?').get(userId);
  if (!row || !row.refresh_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.access_token && row.expires_at > now + 120) return row.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google_client_id,
      client_secret: config.google_client_secret,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!tok.access_token) return null;
  const expiresAt = now + (Number(tok.expires_in) || 3600);
  db.prepare('UPDATE google_tokens SET access_token = ?, expires_at = ? WHERE user_id = ?')
    .run(tok.access_token, expiresAt, userId);
  return tok.access_token;
}

async function ytApi(userId, apiPath, params = {}) {
  const access = await googleAccessToken(userId);
  if (!access) throw new Error('Google account not linked — sign in with Google (it asks for YouTube access), then try again.');
  const qs = new URLSearchParams({ key: '', ...params });
  qs.delete('key');
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${apiPath}?${qs}`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && body.error && body.error.message) || `YouTube API error (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function iso8601Seconds(dur) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(dur || ''));
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

async function ytVideoDetails(userId, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const body = await ytApi(userId, 'videos', { part: 'snippet,contentDetails', id: batch.join(','), maxResults: '50' });
    for (const it of body.items || []) {
      out.set(it.id, {
        videoId: it.id,
        title: String((it.snippet && it.snippet.title) || ''),
        channel: String((it.snippet && it.snippet.channelTitle) || ''),
        duration: iso8601Seconds(it.contentDetails && it.contentDetails.duration),
      });
    }
  }
  return out;
}

/* ---------------- Library endpoints ---------------- */

function sendLibrary(res, userId) {
  const songs = db.prepare('SELECT * FROM songs WHERE user_id = ? ORDER BY created_at DESC').all(userId).map(sanitizeSong);
  const playlists = db.prepare('SELECT id, name, song_ids, created_at FROM playlists WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    .map((p) => ({ id: p.id, name: p.name, songIds: JSON.parse(p.song_ids || '[]'), createdAt: p.created_at * 1000 }));
  const sRow = db.prepare('SELECT value FROM settings WHERE user_id = ?').get(userId);
  const settings = sRow ? JSON.parse(sRow.value || '{}') : {};
  // storage actually sitting on the server for this user (uploads + yt downloads)
  const serverRow = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM songs WHERE user_id = ? AND size > 0').get(userId);
  json(res, 200, { songs, playlists, settings, serverBytes: serverRow.bytes, serverCount: serverRow.count });
}

function saveSettingsRow(userId, settings) {
  db.prepare(`
    INSERT INTO settings (user_id, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(userId, JSON.stringify(settings || {}));
}

function upsertPlaylist(userId, p) {
  if (!safeId(p.id)) return;
  db.prepare(`
    INSERT INTO playlists (id, user_id, name, song_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, song_ids = excluded.song_ids, updated_at = unixepoch()
    WHERE playlists.user_id = excluded.user_id
  `).run(p.id, userId, cleanText(p.name || 'Untitled', 120), JSON.stringify(Array.isArray(p.songIds) ? p.songIds.slice(0, 5000) : []));
}

/* ---------------- YouTube download jobs ---------------- */

const ytJobs = new Map();
const YT_MAX_CONCURRENT = Math.max(1, Math.min(12, parseInt(process.env.YT_MAX_CONCURRENT || '6', 10) || 6));
const YT_JOB_PRUNE_MS = 5 * 60 * 1000;

function jobView(job) {
  return {
    id: job.id,
    videoId: job.videoId,
    title: job.title || null,
    thumbUrl: job.thumbUrl || null,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    bytes: job.bytes,
    total: job.total,
    error: job.error,
    deduped: job.deduped,
    playlistId: job.playlistId || null,
    song: job.song ? sanitizeSong(job.song) : null,
  };
}

function cleanupYtJobTemp(job) {
  const dir = path.join(AUDIO_DIR, String(job.userId));
  const prefix = `ytjob_${job.id}`;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix + '.')) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { }
      }
    }
  } catch { }
}

function scheduleYtJobs() {
  // Start as many queued jobs as there are free slots — the old version
  // started only ONE per call, so bulk imports trickled out one at a time.
  for (;;) {
    const running = [...ytJobs.values()].filter((j) => j.status === 'running').length;
    if (running >= YT_MAX_CONCURRENT) return;
    const next = [...ytJobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return;
    runYtJob(next);
  }
}

function enqueueYtJob(userId, videoId, opts = {}) {
  const duplicate = [...ytJobs.values()].find((j) => j.userId === userId && j.videoId === videoId
    && (j.status === 'queued' || j.status === 'running'));
  if (duplicate) return { job: duplicate, existing: true };
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    userId,
    videoId,
    createdAt: Date.now(),
    title: opts.titleHint || null,
    thumbUrl: opts.titleHint ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
    status: 'queued',
    stage: 'Queued',
    progress: 0,
    bytes: 0,
    total: 0,
    error: null,
    song: null,
    deduped: false,
    controller: null,
    playlistId: opts.playlistId || null,
  };
  ytJobs.set(job.id, job);
  return { job, existing: false };
}

function addSongToPlaylist(userId, playlistId, songId) {
  try {
    const row = db.prepare('SELECT song_ids FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
    if (!row) return;
    const ids = JSON.parse(row.song_ids || '[]');
    if (!ids.includes(songId)) {
      ids.push(songId);
      db.prepare('UPDATE playlists SET song_ids = ?, updated_at = unixepoch() WHERE id = ?')
        .run(JSON.stringify(ids.slice(0, 5000)), playlistId);
    }
  } catch { }
}

async function runYtJob(job) {
  job.status = 'running';
  job.stage = 'Starting';
  job.controller = new AbortController();
  const leftovers = [];
  try {
    const existing = db.prepare('SELECT * FROM songs WHERE user_id = ? AND source = ?')
      .get(job.userId, `youtube:${job.videoId}`);
    if (existing) {
      job.song = existing;
      job.deduped = true;
      job.title = existing.title || null;
      job.status = 'done';
      job.progress = 1;
      return;
    }
    // The download itself now returns the video's metadata (yt-dlp writes an
    // info file in the same run), so the old separate "Fetching video info"
    // yt-dlp call per song is gone — one less YouTube round-trip per song.
    const dir = path.join(AUDIO_DIR, String(job.userId));
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `ytjob_${job.id}`);
    job.stage = 'Downloading';
    const result = await yt.downloadAudio(job.videoId, base, (p) => {
      if (p.stage) job.stage = p.stage;
      if (p.pct) job.progress = Math.max(job.progress, Math.min(0.98, p.pct));
      if (p.total) job.total = p.total;
      if (p.bytes) job.bytes = p.bytes;
    }, job.controller.signal);
    leftovers.push(result.filePath);
    let info = result.info;
    if (!info || !info.title) {
      job.stage = 'Fetching video info';
      info = await yt.getVideo(job.videoId);
    }
    job.title = info.title || job.title;
    job.thumbUrl = info.thumbUrl || job.thumbUrl;

    job.stage = 'Finishing up';
    const dupe = db.prepare('SELECT * FROM songs WHERE user_id = ? AND hash = ?').get(job.userId, result.sha256);
    if (dupe) {
      job.song = dupe;
      job.deduped = true;
      job.title = dupe.title || job.title;
      job.status = 'done';
      job.progress = 1;
      return;
    }

    const art = await yt.fetchThumbnailDataUrl(job.videoId).catch(() => '');
    const meta = yt.parseTitleInto(info.title, info.channel);
    const id = 'y' + crypto.randomBytes(9).toString('hex');
    const rg = result.replayGain || { gainDb: 0, peakDb: 1 };
    db.prepare(`
      INSERT INTO songs (id, user_id, title, artist, album, art, duration, size, hash, source, mime, replaygain_gain, replaygain_peak)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, job.userId, meta.title, meta.artist, meta.album, art,
      Math.max(0, Number(info.duration) || 0), result.size, result.sha256,
      `youtube:${job.videoId}`, result.mime, rg.gainDb, rg.peakDb);
    await fsp.rename(result.filePath, path.join(dir, `${id}.audio`));
    job.song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
    job.status = 'done';
    job.progress = 1;
  } catch (err) {
    if (err && (err.cancelled || err instanceof yt.DownloadCancelledError)) {
      job.status = 'cancelled';
      job.error = null;
    } else {
      job.status = 'error';
      job.error = String((err && err.message) || 'Download failed');
    }
  } finally {
    if (job.status === 'done' && job.song && job.playlistId) {
      addSongToPlaylist(job.userId, job.playlistId, job.song.id);
    }
    for (const f of leftovers) await fsp.rm(f, { force: true }).catch(() => {});
    cleanupYtJobTemp(job);
    job.controller = null;
    setTimeout(() => ytJobs.delete(job.id), YT_JOB_PRUNE_MS);
    scheduleYtJobs();
  }
}

/* ---------------- Static files ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) { res.writeHead(403); res.end('Forbidden'); return true; }
  if (abs.startsWith(DATA_DIR + path.sep) || abs === DATA_DIR) { res.writeHead(403); res.end('Forbidden'); return true; }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback for routes like /library
      const index = path.join(ROOT, 'index.html');
      fs.readFile(index, (e2, data) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const base = path.basename(abs);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html' || base === 'sw.js' || base === 'manifest.json') headers['Cache-Control'] = 'no-cache';
    else headers['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    fs.createReadStream(abs).pipe(res);
  });
  return true;
}

/* ---------------- Router ---------------- */

async function handleApi(req, res, pathname) {
  const user = getUser(req);
  const method = req.method;

  // ---- public auth endpoints ----
  if (pathname === '/api/auth/config' && method === 'GET') {
    const adminsExist = !!db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
    return json(res, 200, {
      providers: oauthProviders(),
      enabled: true,
      needsSetup: !adminsExist,
      serverName: config.server_name || '',
      registrationOpen: config.registration_open !== false,
    });
  }

  if (pathname === '/api/setup/complete' && method === 'POST') {
    const adminsExist = !!db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
    if (adminsExist) return json(res, 409, { error: 'Setup already completed' });
    const { code, email, password, name } = await readJsonBody(req);
    const row = db.prepare('SELECT code FROM setup WHERE id = 1').get();
    if (!row || !row.code) return json(res, 409, { error: 'No setup code found' });
    if (cleanText(code).toUpperCase() !== String(row.code).toUpperCase()) return json(res, 400, { error: 'Wrong setup code — check the server terminal window' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) return json(res, 400, { error: 'Enter a valid email' });
    if (String(password || '').length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
    const info = db.prepare('INSERT INTO users (email, pass_hash, name, provider, role) VALUES (?, ?, ?, ?, ?)')
      .run(String(email).toLowerCase(), hashPassword(String(password)), cleanText(name || '', 80), 'password', 'admin');
    db.prepare('INSERT INTO setup (id, code, done) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET code = NULL, done = 1').run('');
    createSession(res, Number(info.lastInsertRowid));
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (config.registration_open === false) {
      const admin = getUser(req);
      if (!admin || admin.role !== 'admin') return json(res, 403, { error: 'Registration is closed. Ask the admin for an invite.' });
    }
    const { email, password, name } = await readJsonBody(req);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) return json(res, 400, { error: 'Enter a valid email' });
    if (String(password || '').length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (exists) return json(res, 409, { error: 'That email is already registered' });
    const role = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin') ? 'user' : 'admin';
    const info = db.prepare('INSERT INTO users (email, pass_hash, name, provider, role) VALUES (?, ?, ?, ?, ?)')
      .run(String(email).toLowerCase(), hashPassword(String(password)), cleanText(name || String(email).split('@')[0], 80), 'password', role);
    createSession(res, Number(info.lastInsertRowid));
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const { email, password } = await readJsonBody(req);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!row || !row.pass_hash || !verifyPassword(String(password || ''), row.pass_hash)) {
      return json(res, 401, { error: 'Wrong email or password' });
    }
    createSession(res, row.id);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    clearSession(req, res);
    return json(res, 200, { ok: true });
  }

  if (pathname.startsWith('/auth/')) {
    const [, , provider, maybeCb] = pathname.split('/');
    const redirectUri = `${publicOrigin()}/auth/${provider}/callback`;
    if (!maybeCb) {
      const p = oauthProviders();
      if (provider === 'google' && !p.google) return json(res, 404, { error: 'Google login not configured (Server settings in the app)' });
      if (provider === 'github' && !p.github) return json(res, 404, { error: 'GitHub login not configured (Server settings in the app)' });
      beginOAuth(provider, redirectUri, res, oauthNextPath(req));
      return true;
    }
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const st = oauthStates.get(q.get('state') || '');
    if (q.get('error') || !st || st.provider !== provider || st.expires < Date.now()) {
      return json(res, 400, { error: 'OAuth state invalid or expired' });
    }
    const next = oauthSafeNext(st.next);
    oauthStates.delete(q.get('state'));
    try {
      const profile = await finishOAuth(provider, q.get('code'), redirectUri);
      const uid = upsertOAuthUser(profile);
      if (profile.tokens) storeGoogleTokens(uid, profile.tokens);
      createSession(res, uid);
      res.writeHead(302, { Location: next });
      res.end();
    } catch (err) {
      return json(res, 500, { error: 'OAuth failed: ' + err.message });
    }
    return true;
  }

  // ---- public YouTube browse/search ----
  if (pathname === '/api/youtube/search' && method === 'POST') {
    const { query, pageToken, limit } = await readJsonBody(req);
    const q = String(query || '').trim();
    if (!q) return json(res, 400, { error: 'Search query required' });
    try {
      const result = await yt.searchYouTube(q, Math.min(Math.max(1, Number(limit) || 20), 50), pageToken || null);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 422, { error: String((err && err.message) || 'Search failed') });
    }
  }

  if (pathname === '/api/youtube/browse' && method === 'GET') {
    try {
      const shelves = await yt.browseYouTubeMusic();
      return json(res, 200, { shelves });
    } catch (err) {
      return json(res, 422, { error: String((err && err.message) || 'Browse failed') });
    }
  }

  // ---- everything below requires auth ----
  if (!user) return json(res, 401, { error: 'Not signed in' });

  if (pathname === '/api/auth/me' && method === 'GET') {
    return json(res, 200, { user });
  }

  // ---- YouTube downloads ----
  if (pathname === '/api/youtube/resolve' && method === 'POST') {
    const { url } = await readJsonBody(req);
    const videoId = yt.extractVideoId(url);
    if (!videoId) return json(res, 400, { error: 'That does not look like a YouTube link' });
    try {
      const video = await yt.getVideo(videoId);
      return json(res, 200, { video });
    } catch (err) {
      return json(res, 422, { error: String((err && err.message) || 'Could not read that video') });
    }
  }

  if (pathname === '/api/youtube/download' && method === 'POST') {
    const { url } = await readJsonBody(req);
    const videoId = yt.extractVideoId(url);
    if (!videoId) return json(res, 400, { error: 'That does not look like a YouTube link' });
    const { job, existing } = enqueueYtJob(user.id, videoId);
    scheduleYtJobs();
    return json(res, 200, { jobId: job.id, existing });
  }

  if (pathname === '/api/youtube/resolve-playlist' && method === 'POST') {
    const { url } = await readJsonBody(req);
    const pid = yt.extractPlaylistId(url);
    if (!pid) return json(res, 400, { error: 'That does not look like a YouTube playlist link' });
    try {
      const pl = await yt.listPlaylist(url);
      return json(res, 200, {
        playlist: {
          id: pl.playlistId,
          title: pl.title,
          count: pl.count,
          entries: pl.entries.slice(0, 500).map((e) => ({
            videoId: e.videoId, title: e.title, channel: e.channel, duration: e.duration,
          })),
        },
      });
    } catch (err) {
      return json(res, 422, { error: String((err && err.message) || 'Could not read that playlist') });
    }
  }

  // ---- "As you" YouTube lists, via the user's Google login ----
  if (pathname === '/api/youtube/mine/status' && method === 'GET') {
    const access = await googleAccessToken(user.id).catch(() => null);
    return json(res, 200, { linked: !!access });
  }

  if (pathname === '/api/youtube/mine/playlists' && method === 'GET') {
    try {
      const out = [];
      let pageToken = '';
      do {
        const body = await ytApi(user.id, 'playlists', {
          part: 'snippet,contentDetails', mine: 'true', maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        for (const it of body.items || []) {
          out.push({
            id: it.id,
            title: String((it.snippet && it.snippet.title) || 'Untitled'),
            count: Number((it.contentDetails && it.contentDetails.itemCount) || 0),
          });
        }
        pageToken = body.nextPageToken || '';
      } while (pageToken && out.length < 200);
      return json(res, 200, { playlists: out });
    } catch (err) {
      return json(res, 422, { error: String((err && err.message) || 'Could not load your playlists') });
    }
  }

  if (pathname === '/api/youtube/mine/playlist-songs' && method === 'POST') {
    const { playlistId } = await readJsonBody(req);
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(String(playlistId || ''))) {
      return json(res, 400, { error: 'Bad playlist id' });
    }
    try {
      const ids = [];
      let title = 'YouTube playlist';
      let pageToken = '';
      do {
        const body = await ytApi(user.id, 'playlistItems', {
          part: 'snippet', playlistId: String(playlistId), maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        for (const it of body.items || []) {
          const vid = it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId;
          if (vid) ids.push(vid);
        }
        pageToken = body.nextPageToken || '';
      } while (pageToken && ids.length < 500);
      const details = await ytVideoDetails(user.id, ids.slice(0, 500));
      const entries = ids.slice(0, 500).map((id) => details.get(id)).filter(Boolean);
      const pl = await ytApi(user.id, 'playlists', { part: 'snippet', id: String(playlistId) }).catch(() => null);
      if (pl && pl.items && pl.items[0]) title = String(pl.items[0].snippet.title || title);
      return json(res, 200, { playlist: { id: String(playlistId), title, count: entries.length, entries } });
    } catch (err) {
      return json(res, 422, { error: String((err && err.message) || 'Could not load that playlist') });
    }
  }

  if (pathname === '/api/youtube/mine/liked' && method === 'GET') {
    try {
      const all = [];
      let pageToken = '';
      do {
        const body = await ytApi(user.id, 'videos', {
          part: 'snippet,contentDetails', myRating: 'like', maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        for (const it of body.items || []) {
          all.push({
            videoId: it.id,
            title: String((it.snippet && it.snippet.title) || ''),
            channel: String((it.snippet && it.snippet.channelTitle) || ''),
            duration: iso8601Seconds(it.contentDetails && it.contentDetails.duration),
            categoryId: String((it.snippet && it.snippet.categoryId) || ''),
          });
        }
        pageToken = body.nextPageToken || '';
      } while (pageToken && all.length < 500);
      // Return music category only, but fall back to all if none found
      let entries = all.filter((e) => e.categoryId === '10');
      if (!entries.length && all.length) entries = all;
      return json(res, 200, {
        playlist: {
          id: 'liked', title: 'Liked songs', count: entries.length, entries,
          totalLiked: all.length,
        },
      });
    } catch (err) {
      return json(res, 422, { error: String((err && err.message) || 'Could not load your liked songs') });
    }
  }

  /* ---- "For You": personalized shelves from the linked Google account ----
     Built from real listening signals the YouTube Data API exposes:
     liked videos, and artist "radio mixes" derived from the user's top artists
     (library + liked channels). Also includes YouTube Music browse shelves
     (Quick picks, Music videos, etc.). True "Mixed for you / My Mix" playlists
     are ML-private and NOT exposed by the official API, so mixes are seeded
     per-artist via search. */
  if (pathname === '/api/youtube/mine/foryou' && method === 'GET') {
    try {
      const shelves = [];
      // 1) Recently liked — the strongest "I listen to this" signal, music only
      let liked = [];
      try {
        const body = await ytApi(user.id, 'videos', { part: 'snippet,contentDetails', myRating: 'like', maxResults: '50' });
        liked = (body.items || []).map((it) => ({
          videoId: it.id,
          title: String((it.snippet && it.snippet.title) || ''),
          channel: String((it.snippet && it.snippet.channelTitle) || ''),
          duration: iso8601Seconds(it.contentDetails && it.contentDetails.duration),
          categoryId: String((it.snippet && it.snippet.categoryId) || ''),
        }));
        // Prefer actual music videos when there are enough of them
        const musicOnly = liked.filter((e) => e.categoryId === '10');
        if (musicOnly.length >= 6) liked = musicOnly;
      } catch { }
      if (liked.length) shelves.push({ title: 'Recently liked', items: liked.slice(0, 16) });

      // 2) YouTube Music browse shelves (music sections: Quick picks, Music videos, etc.)
      // Use the same browse logic as the public endpoint
      try {
        const browseData = await yt.browseYouTubeMusic();
        if (browseData && browseData.length) {
          for (const s of browseData.slice(0, 3)) {
            if (s.items && s.items.length >= 3) {
              shelves.push({ title: s.title, items: s.items.slice(0, 20) });
            }
          }
        }
      } catch { }

      // 3) Top artists -> seeded radio mixes (search "<artist> mix")
      const artistCounts = new Map();
      const bumpArtist = (name) => {
        const a = String(name || '').trim();
        if (a.length < 2 || a.length > 60) return;
        if (/^(unknown|various|youtube|music|video|audio)$/i.test(a)) return;
        artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
      };
      for (const e of liked) {
        const dash = e.title.split(/\s+-\s+/);
        if (dash.length > 1) bumpArtist(dash[0]);
        bumpArtist(String(e.channel || '').replace(/\s*(VEVO|- ?Topic|Topic|Official|Records?|Music|TV|Promotion)$/i, ''));
      }
      try {
        const lib = db.prepare('SELECT artist, COUNT(*) AS c FROM songs WHERE user_id = ? GROUP BY artist ORDER BY c DESC LIMIT 15').all(user.id);
        for (const row of lib) bumpArtist(row.artist);
      } catch { }
      const topArtists = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 4);
      if (topArtists.length) {
        const mixes = (await Promise.all(topArtists.map(async (artist) => {
          try {
            const r = await yt.searchYouTube(`${artist} songs mix`, 12);
            return { artist, items: (r.results || []).slice(0, 12) };
          } catch { return { artist, items: [] }; }
        }))).filter((m) => m.items.length >= 3);
        for (const m of mixes.slice(0, 3)) {
          shelves.push({ title: `${m.artist} mix`, items: m.items });
        }
      }
      return json(res, 200, { shelves, artists: topArtists });
    } catch (err) {
      return json(res, 422, { error: String((err && err.message) || 'Could not build your feed') });
    }
  }

  // Bulk import: a playlist link, a blob of pasted links, or a list of URLs.
  // Songs already in the library (or already downloading) are skipped.
  if (pathname === '/api/youtube/import' && method === 'POST') {
    const body = await readJsonBody(req);
    const inputs = [];
    if (Array.isArray(body.urls)) inputs.push(...body.urls.map(String));
    if (body.url) inputs.push(String(body.url));
    if (body.text) inputs.push(String(body.text));
    const hasEntries = Array.isArray(body.entries) && body.entries.length > 0;
    if (!inputs.length && !hasEntries) {
      return json(res, 400, { error: 'Paste a playlist link or some song links first' });
    }

    let videoIds = [];
    let playlistTitle = null;
    let titleHints = new Map();
    // Entries straight from the app's own YouTube API lists (My playlists /
    // Liked) — already resolved, titles included.
    if (Array.isArray(body.entries) && body.entries.length && !inputs.length) {
      playlistTitle = body.playlistTitle ? cleanText(body.playlistTitle, 120) : null;
      for (const e of body.entries.slice(0, 500)) {
        const vid = String((e && e.videoId) || '');
        if (!/^[a-zA-Z0-9_-]{11}$/.test(vid)) continue;
        if (!videoIds.includes(vid)) videoIds.push(vid);
        if (e && e.title && !titleHints.has(vid)) titleHints.set(vid, String(e.title));
      }
    }
    for (const input of inputs) {
      const pid = yt.extractPlaylistId(input);
      // A watch URL carries a list= too (the playlist/mix it was played
      // from) — on its own that's still just one song. It expands to the
      // whole list only when the user explicitly hits "import the mix/
      // playlist too" (forcePlaylist) or pasted an actual /playlist link.
      const isPlaylistPage = /\/playlist\b/.test(input)
        || (pid && !yt.extractVideoId(input))
        || (pid && body.forcePlaylist === true);
      if (pid && isPlaylistPage) {
        try {
          const pl = await yt.listPlaylist(input);
          playlistTitle = playlistTitle || pl.title;
          // The modal shows the songs first and lets the user pick — when
          // specific ids come back, import only those.
          const only = Array.isArray(body.ids) && body.ids.length
            ? new Set(body.ids.map(String)) : null;
          for (const e of pl.entries) {
            if (only && !only.has(e.videoId)) continue;
            if (!videoIds.includes(e.videoId)) videoIds.push(e.videoId);
            if (e.title) titleHints.set(e.videoId, e.title);
          }
        } catch (err) {
          return json(res, 422, { error: String((err && err.message) || 'Could not read that playlist') });
        }
      } else {
        for (const id of yt.extractAllVideoIds(input)) {
          if (!videoIds.includes(id)) videoIds.push(id);
        }
      }
    }
    if (!videoIds.length) return json(res, 400, { error: 'No YouTube songs found in that paste' });
    if (videoIds.length > 500) videoIds = videoIds.slice(0, 500);

    let appPlaylistId = null;
    if (body.createPlaylist === true && playlistTitle) {
      appPlaylistId = 'pl' + crypto.randomBytes(8).toString('hex');
      db.prepare(`
        INSERT INTO playlists (id, user_id, name, song_ids, created_at, updated_at)
        VALUES (?, ?, ?, '[]', unixepoch(), unixepoch())
      `).run(appPlaylistId, user.id, cleanText(playlistTitle, 120));
    }

    let queued = 0, alreadyActive = 0, alreadyOwned = 0;
    const jobIds = [];
    for (const vid of videoIds) {
      const owned = db.prepare('SELECT id FROM songs WHERE user_id = ? AND source = ?')
        .get(user.id, `youtube:${vid}`);
      if (owned) {
        alreadyOwned++;
        if (appPlaylistId) addSongToPlaylist(user.id, appPlaylistId, owned.id);
        continue;
      }
      const { job, existing } = enqueueYtJob(user.id, vid, {
        titleHint: titleHints.get(vid) || null,
        playlistId: appPlaylistId,
      });
      if (existing) alreadyActive++; else queued++;
      jobIds.push(job.id);
    }
    scheduleYtJobs();
    return json(res, 200, {
      ok: true, total: videoIds.length, queued, alreadyActive, alreadyOwned,
      playlistTitle, playlistId: appPlaylistId, jobIds,
    });
  }

  if (pathname === '/api/youtube/jobs' && method === 'GET') {
    const jobs = [...ytJobs.values()]
      .filter((j) => j.userId === user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(jobView);
    return json(res, 200, { jobs });
  }

  if (pathname.startsWith('/api/youtube/jobs/') && method === 'POST' && pathname.endsWith('/cancel')) {
    const job = ytJobs.get(pathname.split('/')[4]);
    if (!job || job.userId !== user.id) return json(res, 404, { error: 'Download job not found' });
    if (job.status === 'queued') {
      job.status = 'cancelled';
      cleanupYtJobTemp(job);
      setTimeout(() => ytJobs.delete(job.id), YT_JOB_PRUNE_MS);
    } else if (job.status === 'running' && job.controller) {
      job.controller.abort();
    }
    return json(res, 200, { ok: true, status: job.status });
  }

  if (pathname.startsWith('/api/youtube/jobs/') && method === 'GET') {
    const job = ytJobs.get(pathname.split('/')[4]);
    if (!job || job.userId !== user.id) return json(res, 404, { error: 'Download job not found' });
    return json(res, 200, jobView(job));
  }

  // ---- admin ----
  if (pathname === '/api/admin/settings' && method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    return json(res, 200, {
      serverName: config.server_name || '',
      registrationOpen: config.registration_open !== false,
      secureCookies: config.secure_cookies === true || config.secure_cookies === 'true',
      maxUploadMb: config.max_upload_mb || 500,
      googleClientId: config.google_client_id || '',
      googleClientSecret: config.google_client_secret || '',
      githubClientId: config.github_client_id || '',
      githubClientSecret: config.github_client_secret || '',
      publicOrigin: publicOrigin(),
      providers: oauthProviders(),
    });
  }

  if (pathname === '/api/admin/settings' && method === 'POST') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    const patch = await readJsonBody(req);
    const clean = {};
    for (const k of ['serverName', 'registrationOpen', 'secureCookies', 'maxUploadMb',
      'googleClientId', 'googleClientSecret', 'githubClientId', 'githubClientSecret', 'publicOrigin']) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    }
    saveConfig({
      server_name: cleanText(clean.serverName ?? config.server_name, 80),
      registration_open: clean.registrationOpen === undefined ? config.registration_open !== false : !!clean.registrationOpen,
      secure_cookies: clean.secureCookies === undefined ? secureCookies() : !!clean.secureCookies,
      max_upload_mb: Math.max(1, Math.min(10240, parseInt(clean.maxUploadMb, 10) || config.max_upload_mb || 500)),
      google_client_id: cleanText(clean.googleClientId ?? config.google_client_id, 200),
      google_client_secret: cleanText(clean.googleClientSecret ?? config.google_client_secret, 200),
      github_client_id: cleanText(clean.githubClientId ?? config.github_client_id, 200),
      github_client_secret: cleanText(clean.githubClientSecret ?? config.github_client_secret, 200),
      public_origin: cleanText(clean.publicOrigin ?? publicOrigin(), 200),
    });
    return json(res, 200, { ok: true, providers: oauthProviders(), publicOrigin: publicOrigin() });
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    const rows = db.prepare('SELECT id, email, name, provider, role, created_at FROM users ORDER BY id').all();
    return json(res, 200, {
      users: rows.map(r => ({
        id: r.id, email: r.email, name: r.name, provider: r.provider, role: r.role,
        songs: db.prepare('SELECT COUNT(*) AS c FROM songs WHERE user_id = ?').get(r.id).c,
        createdAt: r.created_at * 1000,
      })),
    });
  }

  if (pathname.startsWith('/api/admin/users/') && method === 'DELETE') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    const targetId = parseInt(pathname.split('/')[4], 10);
    if (!targetId || targetId === user.id) return json(res, 400, { error: 'Cannot remove this account' });
    const victim = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!victim) return json(res, 404, { error: 'User not found' });
    const victimSongs = db.prepare('SELECT id FROM songs WHERE user_id = ?').all(targetId);
    for (const s of victimSongs) {
      await fsp.rm(path.join(AUDIO_DIR, String(targetId), s.id + '.audio'), { force: true }).catch(() => {});
    }
    db.prepare('DELETE FROM songs WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM playlists WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM settings WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    try { await fsp.rm(path.join(AUDIO_DIR, String(targetId)), { recursive: true, force: true }); } catch { }
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/library' && method === 'GET') {
    sendLibrary(res, user.id);
    return true;
  }

  if (pathname === '/api/songs' && method === 'POST') {
    const meta = await readJsonBody(req);
    const hash = String(meta.hash || '');
    if (!hash) return json(res, 400, { error: 'Missing hash' });
    const dupe = db.prepare('SELECT * FROM songs WHERE user_id = ? AND hash = ?').get(user.id, hash);
    if (dupe) return json(res, 200, { song: sanitizeSong(dupe), deduped: true });
    const id = 'c' + crypto.randomBytes(9).toString('hex');
    db.prepare(`
      INSERT INTO songs (id, user_id, title, artist, album, art, duration, size, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, cleanText(meta.title, 300), cleanText(meta.artist || 'Unknown Artist', 300),
      cleanText(meta.album || 'Unknown Album', 300), mtArt(meta.art), Math.max(0, Number(meta.duration) || 0),
      Math.max(0, Number(meta.size) || 0), hash);
    const row = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
    return json(res, 200, { song: sanitizeSong(row) });
  }

  if (pathname.startsWith('/api/songs/') && pathname.endsWith('/file') && method === 'PUT') {
    const songId = pathname.split('/')[3];
    const row = db.prepare('SELECT * FROM songs WHERE id = ? AND user_id = ?').get(songId, user.id);
    if (!row) return json(res, 404, { error: 'Song not found' });
    if (Number(req.headers['content-length'] || 0) > maxUploadBytes()) return json(res, 413, { error: 'File too large' });
    const dir = path.join(AUDIO_DIR, String(user.id));
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, row.id + '.audio');
    const tmpPath = finalPath + '.tmp';
    const out = fs.createWriteStream(tmpPath);
    let total = 0;
    let overflow = false;
    req.on('data', (c) => { total += c.length; if (total > maxUploadBytes()) { overflow = true; req.destroy(); } });
    try {
      await new Promise((resolve, reject) => {
        req.pipe(out);
        out.on('error', reject);
        out.on('finish', resolve);
        req.on('error', reject);
      });
      if (overflow) { await fsp.rm(tmpPath, { force: true }).catch(() => {}); return json(res, 413, { error: 'File too large' }); }
      await fsp.rename(tmpPath, finalPath);
      let rg = { gainDb: 0, peakDb: 1 };
      try {
        rg = await yt.normalizeAudio(finalPath);
      } catch { }
      db.prepare('UPDATE songs SET replaygain_gain = ?, replaygain_peak = ? WHERE id = ?')
        .run(rg.gainDb, rg.peakDb, row.id);
      return json(res, 200, { ok: true, size: total });
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      if (!res.headersSent) return json(res, 500, { error: 'Upload failed' });
    }
  }

  if (pathname.startsWith('/api/songs/') && pathname.endsWith('/audio') && method === 'GET') {
    const songId = pathname.split('/')[3];
    const row = db.prepare('SELECT * FROM songs WHERE id = ? AND user_id = ?').get(songId, user.id);
    if (!row) { res.writeHead(404); res.end(); return true; }
    const filePath = path.join(AUDIO_DIR, String(user.id), row.id + '.audio');
    let st;
    try { st = await fsp.stat(filePath); } catch { res.writeHead(404); res.end(); return true; }
    const range = req.headers.range;
    const baseHeaders = {
      'Content-Type': row.mime || 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    };
    const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return true; }
      end = Math.min(end, st.size - 1);
      const headers = { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 };
      res.writeHead(206, headers);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...baseHeaders, 'Content-Length': st.size });
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  }

  if (pathname.startsWith('/api/songs/') && method === 'DELETE') {
    const songId = pathname.split('/')[3];
    const row = db.prepare('SELECT * FROM songs WHERE id = ? AND user_id = ?').get(songId, user.id);
    if (!row) return json(res, 404, { error: 'Not found' });
    db.prepare('DELETE FROM songs WHERE id = ?').run(songId);
    const pls = db.prepare('SELECT id, song_ids FROM playlists WHERE user_id = ?').all(user.id);
    for (const p of pls) {
      const ids = JSON.parse(p.song_ids || '[]');
      if (ids.includes(songId)) {
        db.prepare('UPDATE playlists SET song_ids = ?, updated_at = unixepoch() WHERE id = ?')
          .run(JSON.stringify(ids.filter((x) => x !== songId)), p.id);
      }
    }
    await fsp.rm(path.join(AUDIO_DIR, String(user.id), row.id + '.audio'), { force: true }).catch(() => {});
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJsonBody(req);
    saveSettingsRow(user.id, body);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/playlists' && method === 'POST') {
    const body = await readJsonBody(req);
    const list = Array.isArray(body.playlists) ? body.playlists : [body];
    for (const p of list) upsertPlaylist(user.id, p);
    return json(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/playlists/') && method === 'DELETE') {
    const plId = pathname.split('/')[3];
    if (safeId(plId)) db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(plId, user.id);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'Unknown endpoint' });
  return true;
}

function mtArt(art) {
  const s = String(art || '');
  return s.startsWith('data:image/') && s.length < 409600 ? s : '';
}

/* ---------------- First-run setup ---------------- */

function bootstrapSetup() {
  db.prepare('INSERT OR IGNORE INTO setup (id, code, done) VALUES (1, NULL, 0)').run();
  const adminsExist = !!db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
  if (adminsExist) return;
  const existing = db.prepare('SELECT code, done FROM setup WHERE id = 1').get();
  if (existing && existing.done) return;
  const code = existing && existing.code ? existing.code : '';
  const finalCode = code || (process.env.SETUP_CODE ? String(process.env.SETUP_CODE).toUpperCase() : '') || humaneCode();
  db.prepare('INSERT INTO setup (id, code, done) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET code = excluded.code').run(finalCode);
  return finalCode;
}

function humaneCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  let out = '';
  for (let i = 0; i < 3; i++) out += letters[crypto.randomInt(letters.length)];
  out += '-';
  for (let i = 0; i < 4; i++) out += digits[crypto.randomInt(digits.length)];
  return out;
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  try {
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end(); return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error(`[error] ${req.method} ${pathname}:`, err);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
});

const setupCode = bootstrapSetup();

server.listen(PORT, HOST, () => {
  const p = oauthProviders();
  const admins = !!db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
  console.log('──────────────────────────────────────────────');
  console.log('  My Spotify server');
  console.log(`  local:   http://localhost:${PORT}`);
  console.log(`  network: http://${ipAddr()}:${PORT}`);
  console.log(`  origin:  ${publicOrigin()}`);
  console.log(`  google:  ${p.google ? 'configured' : 'not configured'}`);
  console.log(`  github:  ${p.github ? 'configured' : 'not configured'}`);
  console.log(`  youtube: ${yt.toolPath('yt-dlp') ? 'yt-dlp (native audio, no re-encode)' : 'built-in downloader'}`);
  console.log(`  storage: ${AUDIO_DIR}`);
  console.log('──────────────────────────────────────────────');
  if (setupCode) {
    console.log('  FIRST RUN — create your admin account:');
    console.log(`  open http://localhost:${PORT} in a browser and`);
    console.log(`  enter this setup code when asked:  ${setupCode}`);
    console.log('  (email + password login always works, no setup needed)');
    console.log('──────────────────────────────────────────────');
  } else if (!admins) {
    console.log(`  No admin yet — open http://localhost:${PORT} to finish setup.`);
    console.log('──────────────────────────────────────────────');
  }
});

function ipAddr() {
  const os = require('os');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return 'localhost';
}
