'use strict';

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const DB_NAME = 'MySpotifyDB';
const DB_VERSION = 2;
const STORE_SONGS = 'songs';
const STORE_PLAYLISTS = 'playlists';
const STORE_QUEUE = 'queue';
const STORE_SETTINGS = 'settings';

let db;
let audioEngine = null;
let fallbackAudio = new Audio();
let currentSong = null;
let currentObjectUrl = null;
let isPlaying = false;
let songs = [];
let playlists = [];
let queue = [];
let queueIndex = -1;
let progressInterval;
let volume = 0.8;
let isMuted = false;
let savedVolume = 0.8;
let repeatMode = 'off'; // off, one, all
let shuffle = false;
let autoOffline = true;
let prefetchRun = null;
let preloadObjectUrl = null;
let view = 'home';
let currentPlaylistId = null;
let searchTerm = '';
let pendingPickerSongId = null;
let autoFadeSongId = null;

const els = {};

/* ---------------- Cloud (accounts + sync) ---------------- */

let me = null;
let authAvailable = false;
let providers = { google: false, github: false };
const authConfig = { serverName: '', registrationOpen: true, needsSetup: false };
let syncBusy = false;
let uploadQueue = [];
let uploading = false;
let statusToastEl = null;
let pushSettingsTimer = null;
let pushPlaylistsTimer = null;
// what the server box reports for this account's library (from /api/library)
let serverLib = { bytes: 0, count: 0 };

// Base path when served under a funnel path like /spotify.
// At root, location.pathname is '/' -> base ''. At /spotify or /spotify/ -> '/spotify'.
// Local :8378 use is unchanged (base '').
const APP_BASE = location.pathname.replace(/\/$/, '');
function api(p) {
  if (!p) return p;
  if (/^(https?:|blob:|data:)/.test(p)) return p;
  if (APP_BASE && p.startsWith(APP_BASE + '/')) return p;
  if (!p.startsWith('/')) p = '/' + p;
  return APP_BASE + p;
}

async function apiJson(p, opts = {}) {
  const res = await fetch(api(p), {
    credentials: 'same-origin',
    headers: opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  if (res.status === 401) { setSignedOut(false); throw new Error('Not signed in'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function setSignedOut(notifyServer = true) {
  me = null;
  if (notifyServer === true) { try { localStorage.removeItem('ms_last_owner'); } catch { } }
  songs = songs.filter(s => !s.cloudId || s.blob);
  if (notifyServer === true) {
    fetch(api('/api/auth/logout'), { method: 'POST' }).catch(() => {});
  }
  updateAuthUi();
  renderView();
  // Local data is account-scoped: fall back to the signed-out world.
  activateAccountDb('guest').catch((e) => console.warn('activateAccountDb failed', e));
}

async function hashBlob(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function initAuth() {
  try {
    const cfg = await fetch(api('/api/auth/config'), { credentials: 'same-origin' });
    if (cfg.ok) {
      const body = await cfg.json();
      authAvailable = true;
      providers = body.providers || providers;
      authConfig.serverName = body.serverName || '';
      authConfig.registrationOpen = body.registrationOpen !== false;
      authConfig.needsSetup = !!body.needsSetup;
    }
  } catch { authAvailable = false; }
  if (authAvailable) {
    try {
      const meRes = await apiJson('/api/auth/me');
      me = meRes.user;
    } catch { me = null; }
  }
  updateAuthUi();
  renderView();
  if (me) startSyncTimers();
  if (authAvailable && !me && authConfig.needsSetup) {
    openSetupWizard();
    return;
  }
  if (me) {
    try {
      const lib = await apiJson('/api/library');
      claimAllowed = ((lib.songs || []).length + (lib.playlists || []).length) > 0;
    } catch { claimAllowed = false; }
    try { await activateAccountDb('u' + me.id); } catch (e) { console.warn('activateAccountDb failed', e); }
    try { await pullLibrary(true); } catch (e) { console.warn('pullLibrary failed', e); }
  } else if (!authAvailable) {
    // Offline: reopen the last signed-in account's DB so the user sees their
    // own music. Never fall back to another user's data.
    let last = null;
    try { last = localStorage.getItem('ms_last_owner'); } catch { last = null; }
    if (last && last !== 'guest' && last !== dbOwner) {
      try { await activateAccountDb(last); } catch (e) { console.warn('activateAccountDb failed', e); }
    } else if (last === dbOwner) {
      // already opened in init(); just re-render
      renderView();
    }
  }
}

async function login(email, password) {
  await apiJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  await afterAuthFlow(email);
}

async function register(email, password, name) {
  await apiJson('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) });
  await afterAuthFlow(email, true);
}

async function afterAuthFlow(email, isNew) {
  const meRes = await apiJson('/api/auth/me');
  me = meRes.user;
  claimAllowed = false;
  if (!isNew) {
    try {
      const lib = await apiJson('/api/library');
      claimAllowed = ((lib.songs || []).length + (lib.playlists || []).length) > 0;
    } catch { claimAllowed = false; }
  }
  await activateAccountDb('u' + me.id);
  updateAuthUi();
  renderView();
  if (isNew) await syncPushPlaylists();
  await pullLibrary(true);
  fetchDlJobs();
  startSyncTimers();
  await pumpUploads();
  toast(isNew ? `Account created — welcome, ${me.email}` : `Signed in as ${me.email}`);
}

let syncTimersStarted = false;

function startSyncTimers() {
  if (syncTimersStarted) return;
  syncTimersStarted = true;
  setInterval(() => pullLibrary(false), 90000);
  setInterval(() => pumpUploads(), 5000);
}

function updateAuthUi() {
  const authBtn = document.getElementById('authBtn');
  const userBtn = els.userBtn;
  if (!userBtn) return;
  const initial = me ? (me.name || me.email || '?').trim().charAt(0).toUpperCase() : '?';
  els.userBtn.style.display = me ? '' : 'none';
  els.playerUserAvatar && (els.playerUserAvatar.style.display = me ? '' : 'none');
  els.userBtn.textContent = initial;
  els.playerUserAvatar && (els.playerUserAvatar.textContent = initial);
  if (authBtn) {
    if (authAvailable) authBtn.style.display = me ? 'none' : '';
    else authBtn.style.display = 'none';
  }
  els.userBtn.title = me ? me.email : 'Sign in';
  if (els.playerUserAvatar) els.playerUserAvatar.title = me ? me.email : 'Sign in';
}

/* Library pull + merge (server wins on conflict; local-only items pushed) */
async function pullLibrary(firstLogin) {
  if (!me || syncBusy) return;
  syncBusy = true;
  let added = 0, linked = 0, removed = 0, newPlaylists = 0;
  try {
    const lib = await apiJson('/api/library');
    serverLib = { bytes: Number(lib.serverBytes) || 0, count: Number(lib.serverCount) || 0 };

    let serverSettings = null;
    if (firstLogin && lib.settings && Object.keys(lib.settings).length) {
      serverSettings = lib.settings;
    }

    const serverPl = lib.playlists || [];
    const localOnly = playlists.filter(p => !serverPl.some(x => x.id === p.id));
    playlists = serverPl.map(p => ({ id: p.id, name: p.name, songIds: p.songIds || [], createdAt: p.createdAt || Date.now() }));
    for (const lpn of localOnly) playlists.push(lpn);
    newPlaylists = localOnly.length;

    const localByHash = new Map();
    for (const s of songs) if (s.hash) localByHash.set(s.hash, s);
    const cloudIds = new Set(songs.filter(s => s.cloudId).map(s => s.cloudId));

    for (const cs of (lib.songs || [])) {
      if (cloudIds.has(cs.id)) continue;
      const localMatch = cs.hash ? localByHash.get(cs.hash) : null;
      if (localMatch && !localMatch.cloudId) {
        localMatch.cloudId = cs.id;
        localMatch.url = cs.url;
        if (!localMatch.art && cs.art) localMatch.art = cs.art;
        await putSong(localMatch);
        linked++;
        continue;
      }
      const rec = {
        id: 'cl_' + cs.id,
        cloudId: cs.id,
        title: cs.title,
        artist: cs.artist,
        album: cs.album,
        art: cs.art,
        duration: cs.duration,
        size: cs.size,
        hash: cs.hash,
        source: cs.source || '',
        blob: null,
        url: cs.url,
        addedAt: cs.addedAt || Date.now(),
      };
      songs.push(rec);
      await putSong(rec);
      added++;
    }

    const serverIds = new Set((lib.songs || []).map(s => s.id));
    const gone = songs.filter(s => s.cloudId && !serverIds.has(s.cloudId) && !s.blob);
    for (const g of gone) {
      songs = songs.filter(x => x.id !== g.id);
      await deleteSongRecord(g.id);
      removed++;
    }
    for (const p of playlists) await putPlaylist(p);

    if (serverSettings) {
      volume = typeof serverSettings.volume === 'number' ? serverSettings.volume : volume;
      isMuted = !!serverSettings.isMuted;
      repeatMode = serverSettings.repeatMode || repeatMode;
      shuffle = !!serverSettings.shuffle;
      els.btnShuffle.classList.toggle('active', shuffle);
      els.btnRepeat.classList.toggle('active', repeatMode !== 'off');
      els.btnRepeat.classList.toggle('one', repeatMode === 'one');
      setVolume(volume, false);
      updateMuteVisual();
    }
    if (localOnly.length) await syncPushPlaylists();
    renderView();
    const bits = [];
    if (added) bits.push(`${added} from cloud`);
    if (linked) bits.push(`${linked} linked`);
    if (removed) bits.push(`${removed} removed`);
    if (newPlaylists) bits.push(`${newPlaylists} playlist${newPlaylists === 1 ? '' : 's'}`);
    if (bits.length) toast(`Synced: ${bits.join(', ')}`);
  } catch (err) {
    if (String(err.message) !== 'Not signed in') toast('Sync failed: ' + err.message, 'warn');
  } finally {
    syncBusy = false;
  }
}

/* Upload local songs to the cloud */
function enqueueUpload(song) {
  if (!me || !song.blob || song.cloudId) return;
  uploadQueue.push(song.id);
  scheduleQueueSave();
  if (!navigator.onLine) requestBackgroundSync();
}

async function uploadSong(song) {
  if (!me || !song.blob || song.cloudId) return;
  const hash = song.hash || await hashBlob(song.blob);
  const meta = { hash, title: song.title, artist: song.artist, album: song.album, art: song.art, duration: song.duration, size: song.blob.size };
  const res = await apiJson('/api/songs', { method: 'POST', body: JSON.stringify(meta) });
  song.hash = hash;
  if (!res.deduped) {
    await fetch(api(res.song.url.replace('/audio', '/file')), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: song.blob });
  }
  song.cloudId = res.song.id;
  song.url = res.song.url;
  await putSong(song);
}

async function pumpUploads() {
  // NOTE: return BEFORE the try — a `return` inside try still runs the
  // `finally`, which re-rendered the whole view every 5s even with an
  // empty queue (YouTube view kept resetting).
  if (uploading || !me || !uploadQueue.length) return;
  uploading = true;
  try {
    const total = uploadQueue.length;
    if (!statusToastEl) {
      statusToastEl = document.createElement('div');
      statusToastEl.className = 'toast';
      statusToastEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg><span id="statusToastText">Syncing…</span>';
      els.toastRoot.appendChild(statusToastEl);
      requestAnimationFrame(() => statusToastEl.classList.add('in'));
    }
    let done = 0;
    while (uploadQueue.length) {
      const sid = uploadQueue.shift();
      const song = songs.find(s => s.id === sid);
      if (song && song.blob && !song.cloudId) {
        try {
          await uploadSong(song);
        } catch (err) {
          toast(`Upload failed: ${song.title}`, 'warn');
          await sleep(1200);
        }
      }
      done++;
      const label = statusToastEl.querySelector('#statusToastText');
      if (label) label.textContent = `Syncing library ${done}/${total}…`;
    }
  } finally {
    if (statusToastEl) {
      const s = statusToastEl;
      statusToastEl = null;
      s.querySelector('#statusToastText').textContent = 'Library up to date';
      setTimeout(() => { s.classList.remove('in'); setTimeout(() => s.remove(), 350); }, 1400);
    }
    scheduleQueueSave();
    renderView();
    uploading = false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Playlist push */
function pushPlaylistsSoon() {
  if (!me) return;
  clearTimeout(pushPlaylistsTimer);
  pushPlaylistsTimer = setTimeout(() => { syncPushPlaylists(); }, 700);
}

async function syncPushPlaylists() {
  if (!me) return;
  try {
    await apiJson('/api/playlists', { method: 'POST', body: JSON.stringify({ playlists: playlists.map(p => ({ id: p.id, name: p.name, songIds: p.songIds })) }) });
  } catch { /* retried on next change */ }
}

async function deletePlaylistCloud(id) {
  if (!me) return;
  try { await apiJson('/api/playlists/' + id, { method: 'DELETE' }); } catch { }
}

function pushSettingsSoon() {
  if (!me) return;
  clearTimeout(pushSettingsTimer);
  pushSettingsTimer = setTimeout(() => {
    apiJson('/api/settings', { method: 'PUT', body: JSON.stringify({ volume, isMuted, repeatMode, shuffle }) }).catch(() => {});
  }, 700);
}

function cloudIdOf(song) {
  if (song.cloudId) return song.cloudId;
  if (song.hash) {
    const match = songs.find(s => s.cloudId && s.hash === song.hash);
    if (match) return match.cloudId;
  }
  return null;
}

async function ensureCloudSong(song, onProgress) {
  if (cloudIdOf(song)) return cloudIdOf(song);
  if (song.blob && me) {
    onProgress && onProgress();
    try { await uploadSong(song); } catch { }
  }
  return cloudIdOf(song);
}

/* ---------------- Database ---------------- */

function createStores(d) {
  if (!d.objectStoreNames.contains(STORE_SONGS)) {
    const s = d.createObjectStore(STORE_SONGS, { keyPath: 'id' });
    s.createIndex('title', 'title', { unique: false });
    s.createIndex('artist', 'artist', { unique: false });
  }
  if (!d.objectStoreNames.contains(STORE_PLAYLISTS)) {
    d.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
  }
  if (!d.objectStoreNames.contains(STORE_QUEUE)) {
    d.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
  }
  if (!d.objectStoreNames.contains(STORE_SETTINGS)) {
    d.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
  }
}

function openDbRaw(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => createStores(e.target.result);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function openDB(name) {
  return openDbRaw(name || DB_NAME).then((h) => { db = h; return h; });
}

/* ---- Account-scoped local worlds ----
   Local data (songs, playlists, queue, settings) lives in one IndexedDB
   per account — '<DB>-guest' signed out, '<DB>-u<id>' per user — so
   switching accounts switches the whole local library with it. The old
   single shared DB ('MySpotifyDB') is claimed ONCE by the first account
   that signs in after this change; every later account starts clean. */
let dbOwner = null;

function dbNameFor(owner) {
  return owner === 'guest' ? DB_NAME + '-guest' : DB_NAME + '-' + owner;
}

/* Set by the sign-in flows: only an account that already HAS a server
   library may claim the legacy local DB — a fresh/empty account must
   never inherit the previous account's local world. */
let claimAllowed = false;

async function claimLegacyDbOnce(owner) {
  if (!claimAllowed) return;
  let already = null;
  try { already = localStorage.getItem('msdb_claimed'); } catch { return; }
  if (already) return;
  try { localStorage.setItem('msdb_claimed', owner); } catch { return; }
  const legacy = await openDbRaw(DB_NAME).catch(() => null);
  if (!legacy) return;
  const readAll = (store) => new Promise((res) => {
    try {
      const rq = legacy.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    } catch { res([]); }
  });
  const readOne = (store, key) => new Promise((res) => {
    try {
      const rq = legacy.transaction(store, 'readonly').objectStore(store).get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    } catch { res(null); }
  });
  const [ls, lp, lq] = await Promise.all([
    readAll(STORE_SONGS), readAll(STORE_PLAYLISTS), readAll(STORE_QUEUE),
  ]);
  const settingRows = {};
  for (const k of ['volume', 'isMuted', 'repeatMode', 'shuffle']) {
    const row = await readOne(STORE_SETTINGS, k);
    if (row) settingRows[k] = row.value;
  }
  try { legacy.close(); } catch { }
  if (!ls.length && !lp.length) return;
  await openDB(dbNameFor(owner));
  for (const s of ls) await putSong(s);
  for (const p of lp) await putPlaylist(p);
  if (lq && lq[0]) await tx(STORE_QUEUE, 'readwrite', (st) => { st.put(lq[0]); return true; });
  for (const [k, v] of Object.entries(settingRows)) await setSetting(k, v);
}

function applySettingsUi() {
  if (!els.btnShuffle) return;
  els.btnShuffle.classList.toggle('active', shuffle);
  els.btnRepeat.classList.toggle('active', repeatMode !== 'off');
  els.btnRepeat.classList.toggle('one', repeatMode === 'one');
  if (audioEngine) {
    audioEngine.setVolume(volume);
    audioEngine.setMuted(isMuted);
  } else if (isMuted) {
    savedVolume = volume || 0.8;
    fallbackAudio.volume = 0;
  } else {
    fallbackAudio.volume = volume;
  }
  els.volumeFill.style.width = `${volume * 100}%`;
  els.volumeKnob.style.left = `${volume * 100}%`;
  updateMuteVisual();
}

async function loadLocalWorld() {
  await loadSettings();
  const [storedSongs, storedPlaylists, queueRec] = await Promise.all([getAllSongs(), getAllPlaylists(), loadQueueRecord()]);
  songs = storedSongs || [];
  playlists = (storedPlaylists || []).sort((a, b) => b.createdAt - a.createdAt);
  queue = [];
  queueIndex = -1;
  currentSong = null;
  if (queueRec && Array.isArray(queueRec.ids)) {
    queue = queueRec.ids.map((id) => songs.find((s) => s.id === id)).filter(Boolean);
    if (queue.length && typeof queueRec.index === 'number' && queueRec.index >= 0 && queueRec.index < queue.length) {
      queueIndex = queueRec.index;
      const st = queue[queueIndex];
      currentSong = st;
      els.playerTitle.textContent = st.title;
      els.playerArtist.textContent = `${st.artist} — ${st.album}`;
      setThumb(st);
      els.playerDuration.textContent = st.duration ? formatTime(st.duration) : '--:--';
    }
  }
  if (!currentSong && els.playerTitle) {
    els.playerTitle.textContent = '';
    els.playerArtist.textContent = '';
    els.playerDuration.textContent = '--:--';
    els.playerCurrent.textContent = '0:00';
    setThumb(null);
  }
  applySettingsUi();
}

async function activateAccountDb(owner) {
  if (dbOwner === owner) return;
  try { pauseAudio(); } catch { }
  if (db) { try { db.close(); } catch { } db = null; }
  if (owner !== 'guest') await claimLegacyDbOnce(owner);
  if (!db) await openDB(dbNameFor(owner));
  dbOwner = owner;
  try { if (owner !== 'guest') localStorage.setItem('ms_last_owner', owner); } catch { }
  await loadLocalWorld();
  renderView();
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('DB not open')); return; }
    let result;
    const t = db.transaction(store, mode);
    const storeObj = t.objectStore(store);
    if (fn) result = fn(storeObj);
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function putSong(song) {
  return tx(STORE_SONGS, 'readwrite', (s) => { s.put(song); return true; });
}
async function getAllSongs() {
  return tx(STORE_SONGS, 'readonly', (s) => s.getAll());
}
async function deleteSongRecord(id) {
  return tx(STORE_SONGS, 'readwrite', (s) => { s.delete(id); return true; });
}
async function getAllPlaylists() {
  return tx(STORE_PLAYLISTS, 'readonly', (s) => s.getAll());
}
async function putPlaylist(p) {
  return tx(STORE_PLAYLISTS, 'readwrite', (s) => { s.put(p); return true; });
}
async function deletePlaylistRecord(id) {
  return tx(STORE_PLAYLISTS, 'readwrite', (s) => { s.delete(id); return true; });
}
async function getSetting(key, def) {
  const row = await tx(STORE_SETTINGS, 'readonly', (s) => s.get(key));
  return row ? row.value : def;
}
async function setSetting(key, value) {
  return tx(STORE_SETTINGS, 'readwrite', (s) => { s.put({ key, value }); return true; });
}
async function loadSettings() {
  volume = await getSetting('volume', 0.8);
  isMuted = await getSetting('isMuted', false);
  repeatMode = await getSetting('repeatMode', 'off');
  shuffle = await getSetting('shuffle', false);
  autoOffline = await getSetting('autoOffline', true);
}
async function saveSettings() {
  await setSetting('volume', volume);
  await setSetting('isMuted', isMuted);
  await setSetting('repeatMode', repeatMode);
  await setSetting('shuffle', shuffle);
  await setSetting('autoOffline', autoOffline);
  pushSettingsSoon();
}

async function loadQueueRecord() {
  const row = await tx(STORE_QUEUE, 'readonly', (s) => s.get(1));
  return row || null;
}
async function saveQueueRecord() {
  return tx(STORE_QUEUE, 'readwrite', (s) => { s.put({ id: 1, ids: queue.map(x => x.id), index: queueIndex }); return true; });
}
let saveQueueTimer = null;
function scheduleQueueSave() {
  clearTimeout(saveQueueTimer);
  saveQueueTimer = setTimeout(() => { saveQueueRecord().catch(() => {}); }, 300);
}

/* ---------------- Utilities ---------------- */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function generateId() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

function gradientFor(seed) {
  const h = hashString(String(seed)) % 360;
  const h2 = (h + 42) % 360;
  return `linear-gradient(135deg, hsl(${h}, 62%, 42%) 0%, hsl(${h2}, 58%, 24%) 100%)`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------- ID3 metadata parsing (v2.3 / v2.4) ---------------- */

async function readID3(file) {
  const out = { title: null, artist: null, album: null, art: null };
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out;
    const major = head[3];
    if (major < 3) return out;
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    const body = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    const dv = new DataView(body.buffer);
    let off = 0;
    while (off + 10 <= body.length) {
      const fid = String.fromCharCode(body[off], body[off + 1], body[off + 2], body[off + 3]);
      if (!/^[A-Z0-9]{4}$/.test(fid)) break;
      const fsize = dv.getUint32(off + 4);
      if (off + 10 + fsize > body.length) break;
      const frame = body.subarray(off + 10, off + 10 + fsize);
      if (fid === 'TIT2' || fid === 'TPE1' || fid === 'TALB') {
        const val = decodeID3Text(frame);
        if (val) {
          if (fid === 'TIT2' && !out.title) out.title = val;
          else if (fid === 'TPE1' && !out.artist) out.artist = val;
          else if (fid === 'TALB' && !out.album) out.album = val;
        }
      } else if (fid === 'APIC' && !out.art) {
        out.art = decodeID3Apic(frame);
      }
      off += 10 + fsize;
    }
  } catch (err) {
    /* skip broken tags silently */
  }
  return out;
}

function decodeID3Text(frame) {
  if (frame.length < 2) return null;
  const enc = frame[0];
  let bytes = frame.subarray(1);
  if (enc === 1 || enc === 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) bytes = bytes.subarray(2);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) bytes = bytes.subarray(2);
  }
  let dec;
  if (enc === 1) dec = new TextDecoder('utf-16le');
  else if (enc === 2) dec = new TextDecoder('utf-16be');
  else dec = new TextDecoder(enc === 3 ? 'utf-8' : 'windows-1252');
  const text = dec.decode(bytes).replace(/\0[\s\S]*$/, '').trim();
  return text || null;
}

function decodeID3Apic(frame) {
  try {
    if (frame.length < 4) return null;
    const enc = frame[0];
    let off = 1;
    while (off < frame.length && frame[off] !== 0) off++;
    const mime = new TextDecoder().decode(frame.subarray(1, off)) || 'image/jpeg';
    off++; // mime null
    off++; // picture type
    if (enc === 1 || enc === 2) {
      while (off + 1 < frame.length && (frame[off] !== 0 || frame[off + 1] !== 0)) off += 2;
      off += 2;
    } else {
      while (off < frame.length && frame[off] !== 0) off++;
      off++;
    }
    if (off >= frame.length) return null;
    const data = frame.subarray(off);
    if (data.length < 100) return null;
    const type = mime.includes('/') ? mime : 'image/jpeg';
    return blobToDataURL(new Blob([data], { type }));
  } catch (err) {
    return null;
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

async function fileToBlob(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim() || 'track';
}

function extForType(type) {
  const map = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac',
    'audio/webm': 'webm', 'audio/x-flac': 'flac',
  };
  return map[String(type || '').split(';')[0].trim().toLowerCase()] || 'mp3';
}

async function downloadSong(song) {
  if (!song) return;
  let blob = song.blob;
  if (!blob && (song.cloudId || song.url)) {
    toast('Preparing download…');
    try {
      const src = song.cloudId ? api('/api/songs/' + song.cloudId + '/audio') : api(song.url);
      const res = await fetch(src, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Download failed');
      blob = await res.blob();
    } catch (err) {
      toast('Download failed', 'warn');
      return;
    }
  }
  if (!blob) {
    toast('No downloadable file for this track', 'warn');
    return;
  }
  const fileName = `${sanitizeFileName(`${song.artist} - ${song.title}`)}.${extForType(blob.type)}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Downloading “${song.title}”`);
}

function probeDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let settled = false;
    const done = (d) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    a.src = url;
  });
}

/* ---------------- Song model ---------------- */

async function addSongFromFile(file) {
  const type = file.type || '';
  const name = file.name || '';
  const looksAudio = type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|webm)$/i.test(name);
  if (!looksAudio) throw new Error('Not an audio file');

  const meta = name.toLowerCase().endsWith('.mp3') ? await readID3(file) : { title: null, artist: null, album: null, art: null };
  const arrayBuffer = await fileToBlob(file);
  const blob = new Blob([arrayBuffer], { type: type || 'audio/mpeg' });
  const duration = await probeDuration(blob);
  const hash = await hashBlob(blob);

  const existing = songs.find(s => s.hash === hash && (s.blob || s.cloudId));
  if (existing) return existing;

  const id = generateId();
  const title = meta.title || name.replace(/\.[^/.]+$/, '');
  const song = {
    id,
    title,
    artist: meta.artist || 'Unknown Artist',
    album: meta.album || 'Unknown Album',
    art: meta.art || '',
    duration,
    size: file.size,
    hash,
    addedAt: Date.now(),
    blob,
  };
  await putSong(song);
  songs.push(song);
  enqueueUpload(song);
  return song;
}

/* ---------------- Queue & playback ---------------- */

function setQueue(list, startIndex = 0, persist = true) {
  queue = list;
  queueIndex = Math.max(-1, Math.min(startIndex, list.length - 1));
  if (persist) scheduleQueueSave();
}

function getNextIndex() {
  if (queue.length === 0) return -1;
  if (shuffle) return Math.floor(Math.random() * queue.length);
  if (repeatMode === 'one') return queueIndex;
  return (queueIndex + 1) % queue.length;
}

function getPrevIndex() {
  if (queue.length === 0) return -1;
  if (repeatMode === 'one') return queueIndex;
  return (queueIndex - 1 + queue.length) % queue.length;
}

function markNowPlaying() {
  document.querySelectorAll('.now-playing').forEach((n) => n.classList.remove('now-playing'));
  if (!currentSong) return;
  const activeEl = document.querySelector(`[data-song-id="${currentSong.id}"]`);
  if (activeEl) activeEl.classList.add('now-playing');
}

function setThumb(song) {
  const img = els.playerThumbImg;
  const fb = els.playerThumbFallback;
  if (song && song.art) {
    img.src = song.art;
    img.style.display = 'block';
    if (fb) fb.style.display = 'none';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    if (fb) {
      fb.style.display = 'flex';
      fb.style.background = song ? gradientFor(song.id) : 'var(--panel)';
      fb.innerHTML = song ? escapeHtml((song.title || '?').trim().charAt(0).toUpperCase()) : '♪';
    }
  }
}

function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: song.album,
      artwork: song.art ? [{ src: song.art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  } catch (err) { /* unsupported */ }
}

const MAX_LOAD_RETRIES = 2;
let loadRetryCount = 0;
let isLoading = false;

async function initAudioEngine() {
  if (!audioEngine) {
    audioEngine = new AudioEngine();
    audioEngine.onEnded = async () => {
      if (repeatMode === 'one') {
        audioEngine.seek(0);
        await audioEngine.resume();
      } else {
        await nextSong();
      }
    };
    audioEngine.onTimeUpdate = (current, duration) => {
      const pct = duration > 0 ? (current / duration) * 100 : 0;
      els.playerProgressFill.style.width = `${pct}%`;
      els.playerCurrent.textContent = formatTime(current);
      if (els.npProgressFill) els.npProgressFill.style.width = `${pct}%`;
      if (els.npCurrent) els.npCurrent.textContent = formatTime(current);
      els.playerDuration.textContent = duration > 0 ? formatTime(duration) : '--:--';
      maybeAutoCrossfade(current, duration);
    };
    audioEngine.onError = (err) => {
      console.error('AudioEngine error:', err);
      toast(`Playback error: ${err.message}`, 'error');
    };
  }
}

async function loadSong(song, autoplay = true, isRetry = false) {
  if (!song) return false;
  if (isLoading) return false;
  isLoading = true;
  if (!isRetry) loadRetryCount = 0;

  await initAudioEngine();

  currentSong = song;
  autoFadeSongId = null;
  els.playerTitle.textContent = song.title;
  els.playerArtist.textContent = `${song.artist} — ${song.album}`;
  setThumb(song);
  syncNowPlaying();
  markNowPlaying();
  updateMediaSession(song);

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  let src;
  if (song.blob) {
    currentObjectUrl = URL.createObjectURL(song.blob);
    src = currentObjectUrl;
  } else if (song.url) {
    src = api(song.url);
  } else {
    toast('This track has no playable source', 'warn');
    isLoading = false;
    if (autoplay) await tryNextSong();
    return false;
  }

  try {
    await audioEngine.load({ ...song, url: src, blobUrl: src });
    isLoading = false;
    loadRetryCount = 0;
    if (song.replayGain && song.replayGain.gainDb) {
      audioEngine.setReplayGain(song.replayGain.gainDb);
    }
    if (autoplay) {
      await audioEngine.resume();
      isPlaying = true;
      updatePlayIcon();
    } else {
      isPlaying = false;
      updatePlayIcon();
    }
    scheduleQueueSave();
    startProgress();
    preloadNextQueueSong();
    schedulePrefetch(3);
    return true;
  } catch (err) {
    isLoading = false;
    return handleLoadError(autoplay, err);
  }
}

async function handleLoadError(autoplay, err) {
  console.error('Audio load error:', err);
  if (loadRetryCount < MAX_LOAD_RETRIES) {
    loadRetryCount++;
    toast(`Playback failed, retrying (${loadRetryCount}/${MAX_LOAD_RETRIES})…`, 'warn');
    await new Promise(r => setTimeout(r, 500 * loadRetryCount));
    return loadSong(currentSong, autoplay, true);
  }
  toast(`Unable to play: ${currentSong?.title || 'track'}`, 'error');
  if (autoplay) await tryNextSong();
  return false;
}

async function tryNextSong() {
  if (!queue.length) return false;
  const nextIndex = getNextIndex();
  if (nextIndex === queueIndex) return false;
  queueIndex = nextIndex;
  return loadSong(queue[queueIndex], true);
}

function syncNowPlaying() {
  const s = currentSong;
  if (els.npTitle) els.npTitle.textContent = s ? s.title : 'Select a song';
  if (els.npArtist) els.npArtist.textContent = s ? `${s.artist} — ${s.album}` : 'No track playing';
  if (els.npArtImg && els.npArtFallback) {
    if (s && s.art) {
      els.npArtImg.src = s.art;
      els.npArtImg.style.display = 'block';
      els.npArtFallback.style.display = 'none';
    } else {
      els.npArtImg.removeAttribute('src');
      els.npArtImg.style.display = 'none';
      els.npArtFallback.style.display = 'flex';
      if (els.npArtFallback) els.npArtFallback.style.background = s ? gradientFor(s.id) : 'var(--panel)';
      if (els.npArtFallback) els.npArtFallback.innerHTML = s ? escapeHtml((s.title || '?').trim().charAt(0).toUpperCase()) : '';
    }
  }
  if (els.npDuration) els.npDuration.textContent = s && s.duration ? formatTime(s.duration) : '--:--';
  // Sync control states
  if (els.npShuffle) els.npShuffle.classList.toggle('active', shuffle);
  if (els.npRepeat) {
    els.npRepeat.classList.toggle('active', repeatMode !== 'off');
    els.npRepeat.classList.toggle('one', repeatMode === 'one');
  }
  updatePlayIcon();
}

function openNowPlaying() {
  if (!currentSong) return;
  syncNowPlaying();
  document.body.classList.add('np-open');
  if (els.npOverlay) {
    els.npOverlay.classList.add('open');
    els.npOverlay.setAttribute('aria-hidden', 'false');
  }
  updatePlayIcon();
}

function closeNowPlaying() {
  document.body.classList.remove('np-open');
  if (els.npOverlay) {
    els.npOverlay.classList.remove('open');
    els.npOverlay.setAttribute('aria-hidden', 'true');
  }
}

async function playAudio() {
  if (!audioEngine) return false;
  try {
    await audioEngine.resume();
    isPlaying = true;
    updatePlayIcon();
    return true;
  } catch (err) {
    isPlaying = false;
    updatePlayIcon();
    if (err.name !== 'AbortError') {
      console.warn('Playback failed:', err.message);
    }
    return false;
  }
}

function pauseAudio() {
  if (audioEngine) audioEngine.pause();
  isPlaying = false;
  updatePlayIcon();
}

async function playPause() {
  if (!currentSong) {
    if (queue.length) await loadSong(queue[Math.max(queueIndex, 0)], true);
    return;
  }
  if (isPlaying) {
    pauseAudio();
  } else {
    const played = await playAudio();
    if (!played && repeatMode !== 'one') {
      await tryNextSong();
    }
  }
}

function updatePlayIcon() {
  const icon = els.playIcon;
  if (icon) {
    icon.innerHTML = isPlaying
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    els.btnPlay.toggleAttribute('data-playing', isPlaying);
  }
  const npIcon = els.npPlayIcon;
  if (npIcon) {
    npIcon.innerHTML = isPlaying
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
  }
  if (els.npPlay) els.npPlay.toggleAttribute('data-playing', isPlaying);
}

/* The song's true length. Most songs arrive with a known-good duration
   (from YouTube/file metadata), but some phone browsers misreport
   audio.duration for streamed AAC — up to exactly 2x. When the two
   disagree wildly, trust the known length for display, progress and
   seeking; the audio element itself still plays the file correctly. */
function playbackDuration() {
  if (audioEngine) {
    const reported = audioEngine.getDuration();
    const known = currentSong && currentSong.duration > 0 ? currentSong.duration : 0;
    if (known && reported && Math.abs(reported - known) / known > 0.1) return known;
    return reported || known || 0;
  }
  const reported = isFinite(fallbackAudio.duration) && fallbackAudio.duration > 0 ? fallbackAudio.duration : 0;
  const known = currentSong && currentSong.duration > 0 ? currentSong.duration : 0;
  if (known && reported && Math.abs(reported - known) / known > 0.1) return known;
  return reported || known || 0;
}

function startProgress() {
  clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    const duration = playbackDuration();
    const current = audioEngine ? audioEngine.getCurrentTime() : (fallbackAudio.currentTime || 0);
    const pct = duration > 0 ? (current / duration) * 100 : 0;
    els.playerProgressFill.style.width = `${pct}%`;
    els.playerCurrent.textContent = formatTime(current);
    if (els.npProgressFill) els.npProgressFill.style.width = `${pct}%`;
    if (els.npCurrent) els.npCurrent.textContent = formatTime(current);
    els.playerDuration.textContent = duration > 0
      ? formatTime(duration)
      : '--:--';
    if (duration && !isPlaying) clearInterval(progressInterval);
  }, 500);
}

function maybeAutoCrossfade(current, duration) {
  if (!audioEngine || !currentSong || !isPlaying) return;
  if (IS_IOS || repeatMode === 'one') return;
  if (autoFadeSongId === currentSong.id) return;
  if (document.hidden) return;
  const fadeSec = Math.max(0, Number(audioEngine.crossfadeDuration) || 0);
  if (!fadeSec) return;
  if (!audioEngine.nextSong || !audioEngine.nextBuffer) return;
  if (!duration || duration <= fadeSec * 1.5) return;
  const remaining = duration - current;
  if (remaining > fadeSec || remaining <= 0.15) return;
  autoFadeSongId = currentSong.id;
  nextSong({ fade: true });
}

async function nextSong(opts = {}) {
  // Track navigation must be deterministic on mobile/iOS.  The preloaded
  // double-deck is an optimization, not a requirement for changing tracks;
  // falling back directly to loadSong avoids stale/partially-armed decks.
  if (!queue.length) return false;
  const nextIndex = getNextIndex();
  if (nextIndex < 0) return false;
  queueIndex = nextIndex;
  return loadSong(queue[queueIndex], true);
}

async function prevSong() {
  if (!queue.length) return;
  // Previous-track controls (including the lock screen) replay the preceding queue item.
  queueIndex = getPrevIndex();
  await loadSong(queue[queueIndex]);
}

/* ---------------- Controls ---------------- */

function toggleShuffle() {
  shuffle = !shuffle;
  els.btnShuffle.classList.toggle('active', shuffle);
  if (els.npShuffle) els.npShuffle.classList.toggle('active', shuffle);
  saveSettings();
}

function toggleRepeat() {
  if (repeatMode === 'off') repeatMode = 'all';
  else if (repeatMode === 'all') repeatMode = 'one';
  else repeatMode = 'off';
  els.btnRepeat.classList.toggle('active', repeatMode !== 'off');
  els.btnRepeat.classList.toggle('one', repeatMode === 'one');
  if (els.npRepeat) {
    els.npRepeat.classList.toggle('active', repeatMode !== 'off');
    els.npRepeat.classList.toggle('one', repeatMode === 'one');
  }
  saveSettings();
}

function setVolume(val, persist = true) {
  volume = Math.max(0, Math.min(1, val));
  if (volume > 0) isMuted = false;
  if (audioEngine) audioEngine.setVolume(volume);
  els.volumeFill.style.width = `${volume * 100}%`;
  els.volumeKnob.style.left = `${volume * 100}%`;
  updateMuteVisual();
  if (persist) saveSettings();
}

function toggleMute() {
  if (!isMuted) {
    savedVolume = volume || 0.8;
    isMuted = true;
    if (audioEngine) audioEngine.setMuted(true);
  } else {
    isMuted = false;
    volume = savedVolume;
    if (audioEngine) audioEngine.setMuted(false);
  }
  els.volumeFill.style.width = `${volume * 100}%`;
  els.volumeKnob.style.left = `${volume * 100}%`;
  updateMuteVisual();
  saveSettings();
}

function updateMuteVisual() {
  const muted = isMuted || volume === 0;
  els.btnMute.classList.toggle('muted', muted);
  els.volumeFill.classList.toggle('muted', muted);
  els.btnMute.innerHTML = muted
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
}

function updateOfflineBadge() {
  els.offlineBadge.classList.toggle('show', !navigator.onLine);
  if (els.offlineBadge) {
    const { count } = offlineStats();
    els.offlineBadge.innerHTML = `<span>Offline${count ? ` · ${count} ready` : ''}</span>`;
  }
}

/* ---------------- Offline library ---------------- */

function songIsOffline(song) {
  return !!(song && (song.blob || (!song.cloudId && !song.url)));
}

function offlineStats() {
  const ready = songs.filter(songIsOffline);
  const bytes = ready.reduce((a, s) => a + (s.blob ? (s.size || s.blob.size || 0) : 0), 0);
  const missing = songs.filter(s => !songIsOffline(s) && (s.cloudId || s.url)).length;
  return { count: ready.length, total: songs.length, missing, bytes };
}

function fmtBytes(b) {
  if (!b) return '0 KB';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(b / 1024))} KB`;
}

function songAudioUrl(song) {
  if (!song) return '';
  if (song.cloudId) return api('/api/songs/' + song.cloudId + '/audio');
  return api(song.url || '');
}

async function fetchSongBlob(song) {
  const src = songAudioUrl(song);
  if (!src) throw new Error('No audio source');
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.blob();
}

async function cacheAudioInSw(song) {
  try {
    if (!('serviceWorker' in navigator)) return;
    const src = songAudioUrl(song);
    if (!src) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) reg.active.postMessage({ type: 'CACHE_AUDIO', urls: [src] });
  } catch { /* SW not ready yet — the IndexedDB copy still covers offline */ }
}

/* Warm a song's artwork into the SW thumbnail cache so the cover still
   shows when offline. YouTube thumbs are remote URLs the SW used to skip. */
async function cacheArtInSw(song) {
  try {
    if (!('serviceWorker' in navigator)) return;
    if (!song || !song.art || !/^https?:\/\//.test(song.art)) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) reg.active.postMessage({ type: 'CACHE_ART', urls: [song.art] });
  } catch { /* art is best-effort — audio is what matters offline */ }
}

async function uncacheAudioInSw(song) {
  try {
    if (!('serviceWorker' in navigator)) return;
    const src = songAudioUrl(song);
    if (!src) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) reg.active.postMessage({ type: 'DELETE_AUDIO', urls: [src] });
  } catch { /* ignore */ }
}

async function saveSongOffline(song, opts = {}) {
  if (songIsOffline(song)) return true;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const blob = await fetchSongBlob(song);
      song.blob = blob;
      if (!song.size) song.size = blob.size;
      await putSong(song);
      cacheAudioInSw(song);
      cacheArtInSw(song);
      if (!opts.quiet) {
        toast('Saved offline');
        renderView();
      }
      return true;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function removeSongOffline(song) {
  if (!song.cloudId && !song.url) return;
  song.blob = null;
  await putSong(song);
  uncacheAudioInSw(song);
  renderView();
}

let prefetchTimer = null;
function schedulePrefetch(count = 3) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => prefetchUpcoming(count), 1500);
}

async function prefetchUpcoming(count = 3) {
  if (!autoOffline || !navigator.onLine || !queue.length) return null;
  if (prefetchRun) return prefetchRun;
  prefetchRun = (async () => {
    let saved = 0;
    try {
      for (let i = 1; i <= Math.min(count, Math.max(0, queue.length - 1)); i++) {
        const s = queue[(queueIndex + i + queue.length) % queue.length];
        if (!s || songIsOffline(s) || !(s.cloudId || s.url)) continue;
        try { await saveSongOffline(s, { quiet: true }); saved++; } catch { }
      }
    } finally {
      prefetchRun = null;
      if (saved) renderView();
    }
    return saved;
  })();
  return prefetchRun;
}

function nextQueueSong() {
  if (queue.length < 2) return null;
  return queue[(queueIndex + 1) % queue.length] || null;
}

async function preloadNextQueueSong() {
  const nx = nextQueueSong();
  if (!audioEngine) return;
  if (preloadObjectUrl) { URL.revokeObjectURL(preloadObjectUrl); preloadObjectUrl = null; }
  if (!nx) return;
  let url = songAudioUrl(nx);
  if (nx.blob) {
    preloadObjectUrl = URL.createObjectURL(nx.blob);
    url = preloadObjectUrl;
  }
  if (!url) return;
  audioEngine.preloadNext({ ...nx, url, blobUrl: url });
  schedulePrefetch(3);
}

async function requestBackgroundSync() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.sync) await reg.sync.register('flush-library');
  } catch { /* unsupported browser */ }
}

async function refreshLibraryAfterSync() {
  if (!navigator.onLine) return;
  try { await pumpUploads(); } catch { }
  if (me) { try { await pullLibrary(false); } catch { } }
}

async function downloadAllOffline() {
  const targets = songs.filter(s => !songIsOffline(s) && (s.cloudId || s.url));
  if (!targets.length) { toast('Everything is already available offline'); return; }
  if (!navigator.onLine) { toast('Connect to the internet first', 'warn'); return; }
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const remaining = (est.quota || 0) - (est.usage || 0);
      if (remaining > 0 && remaining < 300 * 1024 * 1024) {
        toast('Low device storage — offline saves may fail', 'warn', 6000);
      }
    } catch { }
  }
  toast(`Saving ${targets.length} track${targets.length === 1 ? '' : 's'} for offline…`);
  let ok = 0, fail = 0;
  for (const s of targets) {
    try { await saveSongOffline(s, { quiet: true }); ok++; } catch { fail++; }
  }
  renderView();
  toast(`Saved ${ok} track${ok === 1 ? '' : 's'} offline${fail ? ` · ${fail} failed` : ''}`, ok ? 'ok' : 'warn');
}

async function clearOfflineCopies() {
  const targets = songs.filter(s => s.blob && (s.cloudId || s.url));
  if (!targets.length) { toast('No offline copies on this device'); return; }
  const ok = await confirmDialog('Remove offline copies?',
    `This frees space on this device. ${targets.length} track${targets.length === 1 ? '' : 's'} stay in your library and can be streamed again.`);
  if (!ok) return;
  for (const s of targets) {
    s.blob = null;
    await putSong(s);
    uncacheAudioInSw(s);
  }
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg.active) reg.active.postMessage({ type: 'CLEAR_AUDIO' });
    }
  } catch { }
  renderView();
  toast('Offline copies removed');
}

/* ---------------- Rendering ---------------- */

function artHtml(song) {
  if (song.art) return `<img src="${escapeHtml(song.art)}" alt="">`;
  return `<div class="art-fallback" style="background:${gradientFor(song.id)}"><span>${escapeHtml((song.title || '?').trim().charAt(0).toUpperCase())}</span></div>`;
}

function isCurrentSong(song) {
  return currentSong && currentSong.id === song.id;
}

function isYoutubeSong(song) {
  return String(song.source || '').startsWith('youtube');
}

function songCard(song) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.songId = song.id;
  card.innerHTML = `
    <div class="card-art">
      ${artHtml(song)}
      <span class="card-badge">${isYoutubeSong(song)
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> YouTube'
        : song.blob
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M4 20h16"/></svg> Offline'
          : song.cloudId
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .34-8.99 6.5 6.5 0 0 0-12.5 1.74A3.75 3.75 0 0 0 6 19h11.5"/></svg> Cloud'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="14" height="14" rx="2"/><path d="M8 3h10a2 2 0 0 1 2 2v10"/></svg> On device'}</span>
      <div class="card-hover-actions">
        <button class="card-play" title="Play">
          <div class="card-play-inner">
            <svg viewBox="0 0 24 24" fill="#000"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </div>
        </button>
        <button class="icon-btn card-menu" title="More options" aria-label="More options">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
    </div>
    <div class="card-info">
      <div class="card-title">${escapeHtml(song.title)}</div>
      <div class="card-subtitle">${escapeHtml(song.artist)}</div>
    </div>`;
  card.querySelector('.card-play').addEventListener('click', (e) => {
    e.stopPropagation();
    playSongFromCurrentContext(song);
  });
  card.querySelector('.card-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    openSongMenu(song, e.currentTarget);
  });
  card.addEventListener('click', () => playSongFromCurrentContext(song));
  if (isCurrentSong(song)) card.classList.add('now-playing');
  return card;
}

function songRow(song, rowIndex, extraAction = null) {
  const row = document.createElement('div');
  row.className = 'song-row';
  row.dataset.songId = song.id;
  row.innerHTML = `
    <div class="row-num">${isCurrentSong(song) ? '<div class="eq"><span></span><span></span><span></span></div>' : `<span>${rowIndex + 1}</span>`}</div>
    <div class="row-art">${artHtml(song)}</div>
    <div class="row-meta">
      <div class="row-title">${escapeHtml(song.title)}</div>
      <div class="row-artist">${escapeHtml(song.artist)}</div>
    </div>
    <div class="row-album">${escapeHtml(song.album)}</div>
    ${songIsOffline(song) ? '<div class="row-offline" title="Available offline"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M4 20h16"/></svg></div>' : '<div class="row-offline empty"></div>'}
    <div class="row-dur">${song.duration ? escapeHtml(formatTime(song.duration)) : ''}</div>
    <div class="row-actions">
      <button class="icon-btn row-menu" title="More options" aria-label="More options"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
    </div>`;
  row.querySelector('.row-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    openSongMenu(song, e.currentTarget, extraAction);
  });
  row.addEventListener('click', (e) => {
    if (e.target.closest('.row-menu')) return;
    playSongFromCurrentContext(song);
  });
  if (isCurrentSong(song)) row.classList.add('now-playing');
  return row;
}

function playlistCard(p) {
  const card = document.createElement('div');
  card.className = 'card playlist-card';
  card.innerHTML = `
    <div class="card-art">
      <div class="playlist-art" style="background:${gradientFor(p.name + p.id)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      </div>
      <div class="card-hover-actions">
        <button class="card-play" title="Play playlist"><div class="card-play-inner"><svg viewBox="0 0 24 24" fill="#000"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div></button>
        <button class="icon-btn card-menu" title="Playlist options" aria-label="Playlist options">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
    </div>
    <div class="card-info">
      <div class="card-title">${escapeHtml(p.name)}</div>
      <div class="card-subtitle">${p.songIds.length} track${p.songIds.length === 1 ? '' : 's'}</div>
    </div>`;
  card.querySelector('.card-play').addEventListener('click', (e) => {
    e.stopPropagation();
    playPlaylistNow(p.id);
  });
  card.querySelector('.card-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.querySelector('.ctx-menu')) { closeMenus(); return; }
    openPlaylistMenu(p, e.currentTarget);
  });
  card.addEventListener('click', () => {
    currentPlaylistId = p.id;
    setView('playlist');
  });
  return card;
}

function newPlaylistCard() {
  const card = document.createElement('div');
  card.className = 'card add-card';
  card.innerHTML = `
    <div class="card-art"><div class="playlist-art add-art"><span>+</span></div></div>
    <div class="card-info"><div class="card-title">New playlist</div><div class="card-subtitle">Create one</div></div>`;
  card.addEventListener('click', (e) => { e.stopPropagation(); openPlaylistModal(); });
  return card;
}

async function playPlaylistNow(plId) {
  const p = playlists.find(x => x.id === plId);
  if (!p || !p.songIds.length) { toast('This playlist is empty', 'warn'); return; }
  const list = p.songIds.map(id => songs.find(s => s.id === id || s.cloudId === id)).filter(Boolean);
  if (!list.length) { toast('Songs missing from library', 'warn'); return; }
  setQueue(list, 0);
  await loadSong(list[0], true);
  toast(`Playing “${p.name}”`);
}

/* ---------------- Views ---------------- */

function setView(v) {
  // The YouTube Music browse view was removed; a stale saved view
  // (or an old cached tab) lands on Home instead of a blank page.
  if (v === 'youtube') v = 'home';
  view = v;
  // Every view opens at the top: the scroll position used to carry
  // over between tabs, so a new view could open mid-scroll with its
  // first card half-hidden under the sticky header.
  const mainEl = document.querySelector('.main');
  if (mainEl) mainEl.scrollTop = 0;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.nav === v));
  document.querySelectorAll('.mobile-tabs .tab[data-tab]:not([data-tab="create"])').forEach(n => n.classList.toggle('active', n.dataset.tab === v));
  if (v !== 'playlist') currentPlaylistId = null;
  renderView();
  renderSidebarPlaylists();
}

function renderSidebarPlaylists() {
  const list = document.getElementById('sidePlaylistList');
  if (!list) return;
  list.innerHTML = '';
  if (!playlists.length) {
    const empty = document.createElement('div');
    empty.className = 'side-empty';
    empty.textContent = 'No playlists yet';
    list.appendChild(empty);
    return;
  }
  for (const p of playlists) {
    const item = document.createElement('div');
    item.className = 'side-playlist' + (currentPlaylistId === p.id ? ' active' : '');
    item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v18M9 3v18M14 3l5.5 17.5"/></svg><span>${escapeHtml(p.name)}</span>`;
    item.addEventListener('click', () => { currentPlaylistId = p.id; setView('playlist'); });
    list.appendChild(item);
  }
}

function currentSongList() {
  let list = navigator.onLine ? songs : songs.filter(songIsOffline);
  if (view === 'offline') {
    list = songs.filter(songIsOffline);
  } else if (view === 'playlist' && currentPlaylistId) {
    const p = playlists.find(x => x.id === currentPlaylistId);
    list = p ? p.songIds.map(cid => songs.find(s => s.cloudId === cid || s.id === cid)).filter(Boolean) : [];
  } else if (view === 'search') {
    list = searchTerm ? filterSongs(songs, searchTerm) : [...songs].sort((a, b) => b.addedAt - a.addedAt).slice(0, 12);
  } else {
    list = searchTerm ? filterSongs(songs, searchTerm) : [...songs].sort((a, b) => b.addedAt - a.addedAt);
  }
  return list;
}

function renderView() {
  renderSidebarPlaylists();
  const main = els.viewRoot;
  main.innerHTML = '';
  const list = currentSongList();

  if (view === 'playlist') { renderPlaylistDetail(main, list); return; }
  if (view === 'offline') { renderOfflineView(main); return; }

  if (!songs.length && view === 'search' && !searchTerm) {
    main.appendChild(emptyStateEl());
    return;
  }

  if (view === 'home') {
    if (playlists.length) renderShelf(main);
    renderTracksSection(main, list, 'Your Library');
  } else if (view === 'library') {
    renderShelf(main);
    renderTracksSection(main, list, 'All tracks');
  } else if (view === 'search') {
    if (searchTerm) {
      const plays = playlists.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()));
      if (plays.length) renderShelf(main, plays);
      renderTracksSection(main, list, 'Tracks');
    } else {
      renderTracksSection(main, list, 'Recently added');
    }
  }
  markNowPlaying();
}

function renderOfflineView(root) {
  const list = songs.filter(songIsOffline);
  const stats = offlineStats();
  const section = document.createElement('div');
  section.className = 'section offline-section';
  section.innerHTML = `
    <div class="offline-hero">
      <div class="offline-hero-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/><path d="M19 5.5a4 4 0 0 0-2.8-1.2"/></svg>
      </div>
      <div class="offline-hero-text">
        <div class="offline-hero-title">Available offline</div>
        <div class="offline-hero-sub">${stats.count} of ${stats.total} track${stats.total === 1 ? '' : 's'} · ${fmtBytes(stats.bytes)}${stats.missing ? ` · ${stats.missing} still to download` : ''}</div>
      </div>
      <div class="offline-hero-actions">
        <button class="ghost-btn" id="offlineDownloadAll" ${stats.missing ? '' : 'disabled'} title="${stats.missing ? 'Save every missing track on this device' : 'Everything is already saved offline'}">Download all</button>
        <button class="ghost-btn" id="offlineStorageBtn">Storage</button>
        <button class="ghost-btn danger" id="offlineClear" ${stats.count ? '' : 'disabled'} title="${stats.count ? 'Remove all offline copies' : 'Nothing saved offline yet'}">Clear</button>
      </div>
    </div>
    ${stats.total === 0 ? '<div class="offline-hint">Add music to your library first — then use Download all to keep it on this device.</div>' : ''}
    <div class="storage-line">
      <div class="storage-bar"><div class="storage-fill" id="storageFill"></div></div>
      <div class="storage-label" id="storageLabel">Checking device storage…</div>
    </div>
    <label class="offline-toggle">
      <input type="checkbox" id="offlineAutoToggle" ${autoOffline ? 'checked' : ''}>
      <span><b>Auto-save upcoming tracks</b><small>Keeps the next few songs in the queue ready for offline playback.</small></span>
    </label>`;
  root.appendChild(section);

  section.querySelector('#offlineDownloadAll').addEventListener('click', () => downloadAllOffline());
  section.querySelector('#offlineStorageBtn').addEventListener('click', () => openOfflineSettings());
  section.querySelector('#offlineClear').addEventListener('click', () => clearOfflineCopies());
  section.querySelector('#offlineAutoToggle').addEventListener('change', async (e) => {
    autoOffline = e.target.checked;
    saveSettings();
    toast(autoOffline ? 'Auto-save enabled' : 'Auto-save disabled');
  });

  if (list.length) {
    renderTracksSection(root, list, 'On this device');
  } else {
    const empty = document.createElement('div');
    empty.className = 'no-results';
    empty.innerHTML = `<div class="no-results-icon"><svg viewBox="0 0 24 24" width="54" height="54" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg></div><div>Nothing saved offline yet</div><div class="no-results-sub">Use “Download all” or the ⋯ menu on any track</div>`;
    root.appendChild(empty);
  }
  refreshOfflineStorage();
}

async function refreshOfflineStorage() {
  const stats = offlineStats();
  let quota = 0, usage = 0;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      quota = est.quota || 0;
      usage = est.usage || 0;
    }
  } catch { /* unsupported */ }
  const fill = document.getElementById('storageFill');
  const label = document.getElementById('storageLabel');
  if (fill && quota) fill.style.width = `${Math.min(100, (usage / quota) * 100).toFixed(1)}%`;
  if (label) {
    label.textContent = quota
      ? `App data on this device: ${fmtBytes(usage)} of ${fmtBytes(quota)} · Music saved offline: ${fmtBytes(stats.bytes)}`
      : `${fmtBytes(stats.bytes)} of music saved offline on this device`;
  }
}

function openOfflineSettings() {
  closeMenus();
  const stats = offlineStats();
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap open';
  wrap.id = 'offlineWrap';
  wrap.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal modal-small" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="modal-title">Offline &amp; storage</div>
        <button class="icon-btn modal-close" id="offClose" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="offline-stats">
        <div class="offline-stat"><b>${stats.count}</b><span>tracks offline</span></div>
        <div class="offline-stat"><b>${fmtBytes(stats.bytes)}</b><span>on this device</span></div>
        <div class="offline-stat"><b>${stats.missing}</b><span>not downloaded</span></div>
      </div>
      <div class="storage-line">
        <div class="storage-bar"><div class="storage-fill" id="offModalFill"></div></div>
        <div class="storage-label" id="offModalLabel">Checking device storage…</div>
      </div>
      <label class="offline-toggle">
        <input type="checkbox" id="offAutoToggle" ${autoOffline ? 'checked' : ''}>
        <span><b>Auto-save upcoming tracks</b><small>Downloads the next few queue songs in the background.</small></span>
      </label>
      <div class="offline-actions">
        <button class="ghost-btn" id="offDownloadAll">Download library</button>
        <button class="ghost-btn danger" id="offClear">Clear offline copies</button>
      </div>
      <button class="ghost-btn" id="offManage">Open offline library</button>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('#offClose').addEventListener('click', close);
  wrap.querySelector('.modal-backdrop').addEventListener('click', close);
  wrap.querySelector('#offAutoToggle').addEventListener('change', (e) => {
    autoOffline = e.target.checked;
    saveSettings();
  });
  wrap.querySelector('#offDownloadAll').addEventListener('click', async () => { close(); await downloadAllOffline(); });
  wrap.querySelector('#offClear').addEventListener('click', async () => { close(); await clearOfflineCopies(); });
  wrap.querySelector('#offManage').addEventListener('click', () => { close(); setView('offline'); });

  (async () => {
    let quota = 0, usage = 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        quota = est.quota || 0; usage = est.usage || 0;
      }
    } catch { }
    const fill = wrap.querySelector('#offModalFill');
    const label = wrap.querySelector('#offModalLabel');
    if (fill && quota) fill.style.width = `${Math.min(100, (usage / quota) * 100).toFixed(1)}%`;
    if (label) label.textContent = quota
      ? `${fmtBytes(usage)} of ${fmtBytes(quota)} device storage used`
      : `${fmtBytes(stats.bytes)} of music stored offline`;
  })();
}

function renderShelf(root, list = playlists) {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = `<div class="section-head"><div class="section-title">Playlists</div><button class="section-viewall" id="shelfNewBtn">+ New playlist</button></div><div class="grid grid-playlists"></div>`;
  const grid = section.querySelector('.grid-playlists');
  list.forEach(p => grid.appendChild(playlistCard(p)));
  grid.appendChild(newPlaylistCard());
  section.querySelector('#shelfNewBtn').addEventListener('click', () => openPlaylistModal());
  root.appendChild(section);
}

function renderTracksSection(root, list, label) {
  const section = document.createElement('div');
  section.className = 'section';

  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `<div class="section-title">${escapeHtml(label)}</div>`;
  if (songs.length) {
    const addBtn = document.createElement('button');
    addBtn.className = 'section-viewall';
    addBtn.textContent = '+ Add music';
    addBtn.addEventListener('click', () => openAddMusic(addBtn));
    head.appendChild(addBtn);
  }
  section.appendChild(head);
  root.appendChild(section);

  if (!songs.length) {
    section.appendChild(view === 'search' && searchTerm ? noResultsEl() : addFirstTrackNote());
    return;
  }

  if (list.length) {
    const grid = document.createElement('div');
    grid.className = 'grid grid-songs';
    list.forEach(s => grid.appendChild(songCard(s)));
    section.appendChild(grid);
  } else {
    section.appendChild(noResultsEl());
  }
}

function noResultsEl() {
  const note = document.createElement('div');
  note.className = 'no-results';
  note.innerHTML = `<div class="no-results-icon">🔍</div><div>No tracks found${searchTerm ? ` for “${escapeHtml(searchTerm)}”` : ''}</div><div class="no-results-sub">Try a different search</div>`;
  return note;
}

function renderPlaylistDetail(root, list) {
  const p = playlists.find(x => x.id === currentPlaylistId);
  if (!p) { setView('library'); return; }
  const totalDur = list.reduce((acc, s) => acc + (s.duration || 0), 0);
  const detail = document.createElement('div');
  detail.className = 'playlist-detail';
  detail.innerHTML = `
    <div class="playlist-hero" style="background:${gradientFor(p.name + p.id)}">
      <div class="playlist-hero-art"><svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
      <div class="playlist-hero-meta">
        <div class="playlist-hero-kind">Playlist</div>
        <h1>${escapeHtml(p.name)}</h1>
        <div class="playlist-hero-stats">${list.length} track${list.length === 1 ? '' : 's'} · ${formatTime(totalDur)} total${list.filter(songIsOffline).length ? ` · ${list.filter(songIsOffline).length} offline` : ''}</div>
      </div>
    </div>
    <div class="playlist-actions">
      <button class="play-all" id="plPlay"><svg viewBox="0 0 24 24" fill="#000"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Play</button>
      <button class="ghost-btn" id="plShuffle">Shuffle</button>
      <button class="ghost-btn danger" id="plDelete">Delete playlist</button>
      <a class="ghost-btn back" id="plBack" href="#">← Library</a>
    </div>
    <div class="song-list" id="plTracks"></div>`;
  root.appendChild(detail);

  const tracks = detail.querySelector('#plTracks');
  if (list.length) {
    list.forEach((s, i) => {
      const row = songRow(s, i, { label: 'Remove from playlist', fn: async () => {
        const ref = cloudIdOf(s) || (!me ? s.id : null);
        p.songIds = p.songIds.filter(id => id !== ref);
        await storePlaylist(p);
        renderView();
        toast(`Removed from “${p.name}”`);
      } });
      tracks.appendChild(row);
    });
  } else {
    const empty = document.createElement('div');
    empty.className = 'no-results';
    empty.innerHTML = `<div class="no-results-icon">🎧</div><div>Nothing here yet</div><div class="no-results-sub">Use the ⋯ menu on any track → “Add to playlist”</div>`;
    tracks.appendChild(empty);
  }

  detail.querySelector('#plPlay').addEventListener('click', () => playPlaylistNow(p.id));
  detail.querySelector('#plShuffle').addEventListener('click', async () => {
    if (!list.length) { toast('Playlist is empty', 'warn'); return; }
    const order = [...list].sort(() => Math.random() - 0.5);
    setQueue(order, 0);
    await loadSong(order[0], true);
  });
  detail.querySelector('#plBack').addEventListener('click', (e) => { e.preventDefault(); setView('library'); });
  detail.querySelector('#plDelete').addEventListener('click', async () => {
    const ok = await confirmDialog('Delete playlist?', `“${p.name}” will be removed from the cloud and all devices. The songs stay in your library.`);
    if (!ok) return;
    await deletePlaylistRecord(p.id);
    await deletePlaylistCloud(p.id);
    playlists = playlists.filter(x => x.id !== p.id);
    toast('Playlist deleted');
    setView('library');
  });
  markNowPlaying();
}

function addFirstTrackNote() {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
    <div class="empty-title">No tracks yet</div>
    <div class="empty-sub">Add your first track — everything stays on this device</div>
    <button class="primary-btn" id="emptyAddBtn2">+ Add music</button>`;
  el.querySelector('#emptyAddBtn2').addEventListener('click', () => openAddMusic());
  return el;
}

function emptyStateEl() {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
    <div class="empty-title">No music yet</div>
    <div class="empty-sub">Add your first track — everything stays on this device</div>
    <button class="primary-btn" id="emptyAddBtn">+ Add music</button>`;
  el.querySelector('#emptyAddBtn').addEventListener('click', () => openAddMusic());
  return el;
}

function filterSongs(list, query) {
  if (!query) return list;
  const q = query.toLowerCase();
  return list.filter((s) =>
    s.title.toLowerCase().includes(q) ||
    s.artist.toLowerCase().includes(q) ||
    s.album.toLowerCase().includes(q)
  );
}

/* ---------------- Context menu ---------------- */

function closeMenus() {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  pendingPickerSongId = null;
}

function openSongMenu(song, anchor, extraAction = null) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const items = playlists.map(p => ({ label: `Add to ${p.name}`, fn: async () => {
    const ref = await ensureCloudSong(song) || (!me ? song.id : null);
    if (!ref) { toast('Sync to cloud to share playlists', 'warn'); return; }
    if (!p.songIds.includes(ref)) {
      p.songIds.push(ref);
      await storePlaylist(p);
      toast(`Added to “${p.name}”`);
      renderView();
    } else {
      toast(`Already in “${p.name}”`);
    }
  } }));
  items.push({ label: 'New playlist…', fn: () => {
    pendingPickerSongId = song.id;
    openPlaylistModal();
  } });
  items.push({ label: 'Download to device', fn: () => downloadSong(song) });
  if ((song.cloudId || song.url) && !songIsOffline(song)) {
    items.push({ label: 'Save offline', fn: async () => {
      toast('Saving offline…');
      try { await saveSongOffline(song); }
      catch (err) { toast(String(err.message), 'warn'); }
    } });
  }
  if (song.blob && (song.cloudId || song.url)) {
    items.push({ label: 'Remove offline copy', fn: async () => {
      await removeSongOffline(song);
      toast('Offline copy removed (song stays in cloud)');
    } });
  }
  if (extraAction) items.push({ divider: true }, { label: extraAction.label, danger: true, fn: extraAction.fn });
  items.push({ divider: true }, { label: 'Delete from library', danger: true, fn: async () => {
    const isCloud = !!song.cloudId;
    const ok = await confirmDialog('Delete track?', isCloud
      ? `“${song.title}” will be deleted from the server and all your devices.`
      : `“${song.title}” will be removed from your device.`);
    if (!ok) return;
    if (isCloud) {
      try { await apiJson('/api/songs/' + song.cloudId, { method: 'DELETE' }); }
      catch (err) { toast('Server delete failed: ' + err.message, 'warn'); }
    }
    await deleteSongRecord(song.id);
    songs = songs.filter(s => s.id !== song.id);
    let dirtyPlaylist = false;
    for (const p of playlists) {
      const cid = cloudIdOf(song);
      const before = p.songIds.length;
      p.songIds = p.songIds.filter(x => x !== cid && x !== song.id);
      if (p.songIds.length !== before) dirtyPlaylist = true;
    }
    if (dirtyPlaylist) { await Promise.all(playlists.map(p => putPlaylist(p))); pushPlaylistsSoon(); }
    queue = queue.filter(x => x && x.id !== song.id);
    scheduleQueueSave();
    if (currentSong && currentSong.id === song.id) {
      if (audioEngine) audioEngine.pause();
      isPlaying = false;
      updatePlayIcon();
      clearInterval(progressInterval);
      currentSong = null;
      els.playerTitle.textContent = 'Select a song';
      els.playerArtist.textContent = 'No track playing';
      setThumb(null);
    }
    markNowPlaying();
    renderView();
    toast('Track deleted');
  } });

  items.forEach(it => {
    if (it.divider) { const d = document.createElement('div'); d.className = 'ctx-divider'; menu.appendChild(d); return; }
    const button = document.createElement('button');
    button.className = 'ctx-item' + (it.danger ? ' danger' : '');
    button.textContent = it.label;
    button.addEventListener('click', () => { closeMenus(); it.fn(); });
    menu.appendChild(button);
  });
  positionMenu(menu, anchor);
}

function positionMenu(menu, anchor) {
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = r.left, y = r.bottom + 6;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${y}px`;
}

/* ---------------- Add music ---------------- */

const ADD_MUSIC_OPTIONS = [
  {
    label: 'Upload audio files',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    fn: () => pickAudioFiles(),
  },
  {
    label: 'Download from YouTube',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="4"/><polygon points="10 9 15 12 10 15 10 9" fill="currentColor" stroke="none"/></svg>',
    fn: () => openYtModal(),
  },
];

async function downloadPlaylistOffline(p) {
  const list = p.songIds.map(id => songs.find(s => s.id === id || s.cloudId === id)).filter(Boolean);
  if (!list.length) { toast('Playlist is empty', 'warn'); return; }
  // already-offline = has a saved copy, or is local-only (lives on this device)
  const targets = list.filter(s => !songIsOffline(s) && (s.cloudId || s.url));
  if (!targets.length) { toast('All tracks already saved offline'); return; }
  toast(`Saving ${targets.length} track${targets.length === 1 ? '' : 's'} for offline…`);
  let ok = 0, fail = 0;
  for (const s of targets) {
    try { await saveSongOffline(s, { quiet: true }); ok++; } catch { fail++; }
  }
  renderView();
  toast(`Saved ${ok} track${ok === 1 ? '' : 's'} offline${fail ? ` · ${fail} failed` : ''}`, ok ? 'ok' : 'warn');
}

function openPlaylistMenu(p, anchor) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const items = [
    { label: 'Rename…', fn: () => openPlaylistModal(p.name, p.id) },
    { label: 'Download all for offline', fn: () => downloadPlaylistOffline(p) },
    { divider: true },
    { label: 'Delete playlist', danger: true, fn: async () => {
      const ok = await confirmDialog('Delete playlist?', `“${p.name}” will be removed from the cloud and all devices. The songs stay in your library.`);
      if (!ok) return;
      await deletePlaylistRecord(p.id);
      await deletePlaylistCloud(p.id);
      playlists = playlists.filter(x => x.id !== p.id);
      toast('Playlist deleted');
      if (currentPlaylistId === p.id) { currentPlaylistId = null; setView('library'); return; }
      renderView();
    } },
  ];
  items.forEach(it => {
    if (it.divider) { const d = document.createElement('div'); d.className = 'ctx-divider'; menu.appendChild(d); return; }
    const button = document.createElement('button');
    button.className = 'ctx-item' + (it.danger ? ' danger' : '');
    button.textContent = it.label;
    button.addEventListener('click', () => { closeMenus(); it.fn(); });
    menu.appendChild(button);
  });
  positionMenu(menu, anchor);
}

function openAddMusic(anchor) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const opt of ADD_MUSIC_OPTIONS) {
    const btn = document.createElement('button');
    btn.className = 'ctx-item opt';
    btn.innerHTML = `${opt.icon}<span>${escapeHtml(opt.label)}</span>`;
    btn.addEventListener('click', () => { closeMenus(); opt.fn(); });
    menu.appendChild(btn);
  }
  positionMenu(menu, anchor || document.getElementById('addMusicBar'));
}

function pickAudioFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.m4a,.mp3,.wav,.ogg,.flac,.opus';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    let added = 0;
    for (const file of files) {
      try {
        await addSongFromFile(file);
        added++;
      } catch (err) {
        toast(`Could not add ${file.name}`, 'warn');
      }
    }
    input.remove();
    if (added) {
      toast(`Added ${added} track${added === 1 ? '' : 's'}`);
      renderView();
      if (me) pumpUploads();
      if (!currentSong) {
        const list = currentSongList();
        setQueue(list.length ? list : songs, 0);
      }
    }
  });
  input.click();
}

/* ---------------- YouTube download ---------------- */

let ytState = 'idle';
let ytResolved = null;
// When a playlist / mix resolves, this holds { title, entries, selected:Set }
let ytPick = null;

function openYtModal() {
  if (!me) {
    toast('Sign in first — YouTube downloads are saved by your server', 'warn');
    if (authAvailable) openAuthModal();
    return;
  }
  ytState = 'idle';
  ytResolved = null;
  ytPick = null;
  const ytModalEl = els.ytWrap.querySelector('.yt-modal');
  if (ytModalEl) ytModalEl.classList.remove('yt-picking');
  els.ytInput.value = '';
  els.ytPreview.hidden = true;
  els.ytPreview.innerHTML = '';
  els.ytError.hidden = true;
  els.ytError.textContent = '';
  if (els.ytDetect) { els.ytDetect.hidden = true; els.ytDetect.textContent = ''; }
  if (els.ytSongWrap) els.ytSongWrap.hidden = true;
  if (els.ytSongList) els.ytSongList.innerHTML = '';
  if (els.ytPlWrap) els.ytPlWrap.hidden = true;
  els.ytDownload.disabled = true;
  els.ytDownload.textContent = 'Download';
  refreshYtSrcRow();
  els.ytWrap.classList.add('open');
  setTimeout(() => els.ytInput.focus(), 50);
}

/* "As you" sources: the user's own playlists + liked songs via Google. */
let ytGoogleLinked = null;

async function refreshYtSrcRow() {
  if (!els.ytSrcPlaylists) return;
  try {
    const st = await apiJson('/api/youtube/mine/status');
    ytGoogleLinked = !!st.linked;
  } catch { ytGoogleLinked = false; }
  const off = !ytGoogleLinked;
  els.ytSrcPlaylists.classList.toggle('yt-src-off', off);
  els.ytSrcLiked.classList.toggle('yt-src-off', off);
  if (els.ytSrcHint) els.ytSrcHint.hidden = !off;
}

function requireGoogleLink() {
  if (ytGoogleLinked) return true;
  toast('Sign in with Google first — the Google button on the sign-in screen (it asks for YouTube access)', 'warn');
  return false;
}

function showApiEntries(playlist) {
  const entries = playlist.entries || [];
  if (!entries.length) { showYtError('That list came back empty'); return; }
  ytPick = {
    title: playlist.title,
    entries,
    selected: new Set(entries.map((e) => e.videoId)),
    url: null,
    forcePlaylist: false,
    apiEntries: true,
  };
  els.ytPreview.hidden = true;
  if (els.ytPlWrap) els.ytPlWrap.hidden = true;
  const modal = els.ytWrap.querySelector('.yt-modal');
  if (modal) modal.classList.add('yt-picking');
  if (els.ytDetect) {
    els.ytDetect.hidden = false;
    const sub = playlist.totalLiked
      ? `Only the music — ${entries.length} of your ${playlist.totalLiked} liked videos are songs. Pick what you want, hit Import`
      : 'Pick the songs you want — nothing downloads until you hit Import';
    els.ytDetect.innerHTML = `<div class="yt-detect-title">📋 ${escapeHtml(playlist.title)}</div><div class="yt-detect-sub">${sub}</div>`;
  }
  renderYtSongList();
  ytState = 'ready';
  updateYtImportButton();
}

async function loadMyPlaylists() {
  if (!requireGoogleLink()) return;
  els.ytError.hidden = true;
  if (els.ytPlWrap) els.ytPlWrap.hidden = false;
  if (els.ytPlList) els.ytPlList.innerHTML = '<div class="yt-pl-row yt-pl-loading">Loading your playlists…</div>';
  try {
    const res = await apiJson('/api/youtube/mine/playlists');
    const pls = res.playlists || [];
    if (!pls.length) {
      els.ytPlList.innerHTML = '<div class="yt-pl-row yt-pl-loading">No playlists found on that account</div>';
      return;
    }
    els.ytPlList.innerHTML = pls.map((p) => `
      <button class="yt-pl-row" data-pl="${escapeHtml(p.id)}" type="button">
        <span class="yt-pl-title">${escapeHtml(p.title)}</span>
        <span class="yt-pl-count">${p.count} songs →</span>
      </button>`).join('');
    els.ytPlList.querySelectorAll('[data-pl]').forEach((b) => b.addEventListener('click', async () => {
      els.ytPlList.querySelectorAll('.yt-pl-row').forEach((r) => { r.disabled = true; });
      try {
        const r2 = await apiJson('/api/youtube/mine/playlist-songs', { method: 'POST', body: JSON.stringify({ playlistId: b.dataset.pl }) });
        showApiEntries(r2.playlist);
      } catch (err) { showYtError(err.message); }
      els.ytPlList.querySelectorAll('.yt-pl-row').forEach((r) => { r.disabled = false; });
    }));
  } catch (err) {
    if (els.ytPlWrap) els.ytPlWrap.hidden = true;
    showYtError(err.message);
  }
}

async function loadLiked() {
  if (!requireGoogleLink()) return;
  els.ytError.hidden = true;
  els.ytDownload.disabled = true;
  els.ytDownload.textContent = 'Loading liked songs…';
  try {
    const res = await apiJson('/api/youtube/mine/liked');
    showApiEntries(res.playlist);
    ytState = 'ready';
    updateYtImportButton();
  } catch (err) {
    ytState = 'idle';
    els.ytDownload.textContent = 'Download';
    showYtError(err.message);
  }
}

function closeYtModal() {
  els.ytWrap.classList.remove('open');
}

function showYtError(msg) {
  els.ytError.textContent = msg;
  els.ytError.hidden = false;
}

function renderYtPreview() {
  if (!ytResolved) return;
  const v = ytResolved;
  els.ytPreview.innerHTML = `
    <img src="${escapeHtml(v.thumbUrl)}" alt="">
    <div class="yt-preview-meta">
      <div class="yt-preview-title">${escapeHtml(v.title)}</div>
      <div class="yt-preview-sub">${escapeHtml(v.channel || 'YouTube')}${v.duration ? ` · ${formatTime(v.duration)}` : ''}</div>
      ${v.listInfo ? `<div class="yt-list-offer">
        <div class="yt-list-title">📋 ${escapeHtml(v.listInfo.title)}</div>
        <div class="yt-list-sub">${v.listInfo.count} songs came with this link</div>
        <button class="yt-list-btn" id="ytPickList" type="button">See the songs &amp; pick →</button>
      </div>` : ''}
    </div>`;
  els.ytPreview.hidden = false;
  const offerBtn = els.ytPreview.querySelector('#ytPickList');
  if (offerBtn) offerBtn.addEventListener('click', () => showPlaylistPicker(els.ytInput.value.trim(), true));
}

/* Song picker: shows the songs in a playlist / mix BEFORE anything
   downloads, with checkboxes — import grabs only the ticked ones. */
function renderYtSongList() {
  if (!ytPick || !els.ytSongList) return;
  els.ytSongList.innerHTML = ytPick.entries.map((e) => `
    <label class="yt-song-row">
      <input type="checkbox" class="yt-song-check" data-vid="${e.videoId}" ${ytPick.selected.has(e.videoId) ? 'checked' : ''}>
      <img class="yt-song-thumb" src="https://i.ytimg.com/vi/${e.videoId}/default.jpg" alt="" loading="lazy">
      <span class="yt-song-meta">
        <span class="yt-song-title">${escapeHtml(e.title || 'YouTube song')}${ytPick.seedId && e.videoId === ytPick.seedId ? ' <span class="yt-song-chip">This song</span>' : ''}</span>
        <span class="yt-song-sub">${escapeHtml(e.channel || '')}${e.duration ? ` · ${formatTime(e.duration)}` : ''}</span>
      </span>
    </label>`).join('');
  els.ytSongList.querySelectorAll('.yt-song-check').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) ytPick.selected.add(c.dataset.vid);
    else ytPick.selected.delete(c.dataset.vid);
    updateYtImportButton();
  }));
  if (els.ytSongCount) els.ytSongCount.textContent = `${ytPick.entries.length} songs`;
  els.ytSongWrap.hidden = false;
  updateYtImportButton();
}

function updateYtImportButton() {
  const n = ytPick ? ytPick.selected.size : 0;
  els.ytDownload.textContent = n > 0 ? `Import ${n} song${n === 1 ? '' : 's'}` : 'Import songs';
  els.ytDownload.disabled = n === 0;
  if (els.ytSongCount && ytPick) {
    els.ytSongCount.textContent = `${n} of ${ytPick.entries.length} selected`;
  }
}

async function showPlaylistPicker(url, forcePlaylist = false) {
  if (!url) return;
  ytState = 'resolving';
  els.ytDownload.disabled = true;
  els.ytDownload.textContent = 'Loading songs…';
  els.ytError.hidden = true;
  try {
    const res = await apiJson('/api/youtube/resolve-playlist', { method: 'POST', body: JSON.stringify({ url }) });
    const entries = res.playlist.entries || [];
    if (!entries.length) throw new Error('That list came back empty');
    ytPick = {
      title: res.playlist.title,
      entries,
      selected: new Set(entries.map((e) => e.videoId)),
      url,
      forcePlaylist,
      seedId: ytVideoIdsFromText(url)[0] || null,
    };
    // Switch the modal into pick mode: the single-song card steps aside
    // (its song is row 1 of this list anyway) so the title shows once.
    els.ytPreview.hidden = true;
    const modal = els.ytWrap.querySelector('.yt-modal');
    if (modal) modal.classList.add('yt-picking');
    if (els.ytDetect) {
      els.ytDetect.hidden = false;
      els.ytDetect.innerHTML = `<div class="yt-detect-title">📋 ${escapeHtml(res.playlist.title)}</div><div class="yt-detect-sub">Pick the songs you want — nothing downloads until you hit Import</div>`;
    }
    renderYtSongList();
    ytState = 'ready';
    updateYtImportButton();
  } catch (err) {
    ytState = 'idle';
    els.ytDownload.textContent = 'Download';
    showYtError(err.message);
  }
}

function ytVideoIdsFromText(s) {
  const out = new Set();
  for (const m of s.matchAll(/[?&]v=([a-zA-Z0-9_-]{11})\b/g)) out.add(m[1]);
  for (const m of s.matchAll(/youtu\.be\/([a-zA-Z0-9_-]{11})\b/g)) out.add(m[1]);
  for (const m of s.matchAll(/\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})\b/g)) out.add(m[1]);
  return [...out];
}

function ytInputMode(text) {
  const s = text.trim();
  if (!s) return 'empty';
  const hasList = /\/playlist\b/.test(s) || (/[?&]list=([a-zA-Z0-9_-]{8,})/.test(s) && !/[?&]v=([a-zA-Z0-9_-]{11})/.test(s));
  if (hasList) return 'playlist';
  if (ytVideoIdsFromText(s).length > 1 || s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length > 1) return 'multi';
  return 'single';
}

// A single watch URL that ALSO carries the playlist/mix it was playing from.
function ytWatchListParam(text) {
  const s = String(text || '').trim();
  if (/\r?\n/.test(s)) return null;
  const m = s.match(/[?&]list=([a-zA-Z0-9_-]{8,})/);
  return m ? m[1] : null;
}

const ytPreviewSoon = (() => {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(resolveYtPreview, 550);
  };
})();

async function resolveYtPreview() {
  const url = els.ytInput.value.trim();
  if (!url) {
    ytResolved = null;
    els.ytPreview.hidden = true;
    els.ytError.hidden = true;
    els.ytDownload.disabled = true;
    return;
  }
  ytResolved = null;
  ytPick = null;
  const ytModalEl2 = els.ytWrap.querySelector('.yt-modal');
  if (ytModalEl2) ytModalEl2.classList.remove('yt-picking');
  els.ytError.hidden = true;
  els.ytPreview.hidden = true;
  if (els.ytSongWrap) els.ytSongWrap.hidden = true;
  if (els.ytDetect) { els.ytDetect.hidden = true; els.ytDetect.textContent = ''; }
  els.ytDownload.disabled = true;
  ytState = 'resolving';
  els.ytDownload.textContent = 'Checking…';
  try {
    const mode = ytInputMode(url);
    if (mode === 'playlist') {
      await showPlaylistPicker(url, false);
    } else if (mode === 'multi') {
      const ids = ytVideoIdsFromText(url);
      ytPick = {
        title: 'Pasted links',
        entries: ids.map((videoId) => ({ videoId, title: '', channel: '', duration: 0 })),
        selected: new Set(ids),
        url: null,
        forcePlaylist: false,
      };
      if (els.ytDetect) {
        els.ytDetect.hidden = false;
        els.ytDetect.textContent = `🔗 ${ids.length} song links pasted — untick any you don't want`;
      }
      renderYtSongList();
      ytState = 'ready';
      updateYtImportButton();
    } else {
      const res = await apiJson('/api/youtube/resolve', { method: 'POST', body: JSON.stringify({ url }) });
      ytResolved = res.video;
      if (ytWatchListParam(url)) {
        // It rode in on a playlist / radio mix — offer the list picker too.
        try {
          const pl = await apiJson('/api/youtube/resolve-playlist', { method: 'POST', body: JSON.stringify({ url }) });
          if (pl.playlist && pl.playlist.count > 1) {
            ytResolved.listInfo = { title: pl.playlist.title, count: pl.playlist.count };
          }
        } catch { }
      }
      renderYtPreview();
      ytState = 'ready';
      els.ytDownload.textContent = 'Download';
      els.ytDownload.disabled = false;
    }
  } catch (err) {
    ytState = 'idle';
    els.ytDownload.textContent = 'Download';
    showYtError(err.message);
  }
}

let ytImportSyncPending = false;

async function startYtDownload() {
  if (ytState === 'ready' && ytPick && ytPick.selected.size) {
    // Playlist / mix / multi-link import of the selected songs.
    ytState = 'starting';
    els.ytDownload.disabled = true;
    els.ytError.hidden = true;
    try {
      const ids = [...ytPick.selected];
      let body;
      if (ytPick.apiEntries) {
        body = {
          entries: ytPick.entries.filter((e) => ytPick.selected.has(e.videoId)),
          playlistTitle: ytPick.title,
          createPlaylist: false,
        };
      } else if (ytPick.url && ytPick.entries.length) {
        body = { url: ytPick.url, forcePlaylist: ytPick.forcePlaylist, ids, createPlaylist: false };
      } else {
        body = { urls: ids.map((id) => `https://www.youtube.com/watch?v=${id}`), createPlaylist: false };
      }
      const res = await apiJson('/api/youtube/import', { method: 'POST', body: JSON.stringify(body) });
      const bits = [];
      if (res.queued) bits.push(`${res.queued} queued`);
      if (res.alreadyActive) bits.push(`${res.alreadyActive} already downloading`);
      if (res.alreadyOwned) bits.push(`${res.alreadyOwned} already in library`);
      ytState = 'idle';
      closeYtModal();
      ytImportSyncPending = true;
      fetchDlJobs(true);
      toast(bits.length ? `Import started — ${bits.join(', ')}` : 'Import started');
    } catch (err) {
      ytState = 'ready';
      els.ytDownload.disabled = false;
      showYtError(err.message);
    }
    return;
  }
  if (ytState !== 'ready' || !ytResolved) return;
  // Single song — through the download manager like everything else.
  ytState = 'starting';
  els.ytDownload.disabled = true;
  els.ytError.hidden = true;
  try {
    const res = await apiJson('/api/youtube/download', { method: 'POST', body: JSON.stringify({ url: els.ytInput.value.trim() }) });
    ytState = 'idle';
    closeYtModal();
    fetchDlJobs(true);
    toast(res.existing ? 'That one is already downloading' : 'Download started');
  } catch (err) {
    ytState = 'ready';
    els.ytDownload.disabled = false;
    showYtError(err.message);
  }
}

function ytStageLabel(job) {
  if (job.status === 'queued') return 'Queued';
  if (job.stage === 'Fetching video info') return 'Fetching video info…';
  if (job.stage === 'Finishing up') return 'Finishing up…';
  if (job.stage === 'Starting') return 'Starting download…';
  const pct = Math.round((job.progress || 0) * 100);
  const size = job.total ? ` (${(job.bytes / 1048576).toFixed(1)} of ${(job.total / 1048576).toFixed(1)} MB)` : '';
  return `Downloading audio… ${pct}%${size}`;
}

/* ---------------- Download manager ---------------- */

const dlJobs = new Map();
const dlToasted = new Set();
const dlVanishTimers = new Map();
let dlTimer = null;

function dlActive(job) { return job.status === 'queued' || job.status === 'running'; }

async function fetchDlJobs(popOpen = false) {
  if (!me) return;
  let jobs;
  try {
    jobs = (await apiJson('/api/youtube/jobs')).jobs || [];
  } catch { return; }
  for (const job of jobs) {
    dlJobs.set(job.id, job);
    if (job.status === 'done' && job.song && !dlToasted.has(job.id)) {
      dlToasted.add(job.id);
      await mergeDownloadedSong(job.song);
      toast(job.deduped ? `Already in your library — "${job.song.title}"` : `Downloaded "${job.song.title}"`);
    }
    if ((job.status === 'done' || job.status === 'cancelled') && !dlVanishTimers.has(job.id)) {
      dlVanishTimers.set(job.id, setTimeout(() => {
        dlJobs.delete(job.id);
        dlVanishTimers.delete(job.id);
        renderDlManager();
      }, 6000));
    }
  }
  const serverIds = new Set(jobs.map((j) => j.id));
  for (const id of [...dlJobs.keys()]) if (!serverIds.has(id)) dlJobs.delete(id);
  renderDlManager(popOpen);
  clearTimeout(dlTimer);
  if ([...dlJobs.values()].some(dlActive)) dlTimer = setTimeout(() => fetchDlJobs(), 1000);
  if (ytImportSyncPending && ![...dlJobs.values()].some(dlActive)) {
    ytImportSyncPending = false;
    try { await pullLibrary(false); renderView(); } catch { }
  }
}

function renderDlManager(popOpen = false) {
  if (!els.dlManager) return;
  const jobs = [...dlJobs.values()];
  if (!jobs.length) {
    els.dlManager.hidden = true;
    els.dlPanel.hidden = true;
    return;
  }
  els.dlManager.hidden = false;
  if (popOpen) els.dlPanel.hidden = false;
  const active = jobs.filter(dlActive);
  els.dlPillLabel.textContent = active.length ? String(active.length) : '✓';
  const frac = active.length
    ? active.reduce((s, j) => s + (j.progress || 0), 0) / active.length
    : (jobs.some((j) => j.status === 'done') ? 1 : 0);
  els.dlPillFill.style.width = `${Math.round(frac * 100)}%`;
  els.dlList.innerHTML = jobs.map(dlJobHtml).join('');
  wireDlList();
}

function dlJobHtml(job) {
  const title = escapeHtml(job.title || (job.status === 'queued' ? 'Queued download' : 'Fetching video info…'));
  const thumb = job.thumbUrl
    ? `<img src="${escapeHtml(job.thumbUrl)}" alt="">`
    : `<div class="dl-thumb-ph"></div>`;
  let sub = '';
  let bar = '';
  if (job.status === 'queued') {
    sub = `<div class="dl-sub">Queued</div>`;
  } else if (job.status === 'running') {
    sub = `<div class="dl-sub">${escapeHtml(ytStageLabel(job))}</div>`;
    bar = `<div class="dl-bar"><div class="dl-bar-fill" style="width:${Math.round((job.progress || 0) * 100)}%"></div></div>`;
  } else if (job.status === 'done') {
    sub = `<div class="dl-sub dl-ok">✓ Saved to your library</div>`;
  } else if (job.status === 'cancelled') {
    sub = `<div class="dl-sub">Cancelled</div>`;
  } else if (job.status === 'error') {
    sub = `<div class="dl-sub dl-err">${escapeHtml(job.error || 'Download failed')}</div>`;
  }
  const active = dlActive(job);
  const actions = [];
  if (active) actions.push(`<button class="dl-x" data-cancel="${job.id}" title="Cancel download" type="button">✕</button>`);
  if (job.status === 'error') {
    actions.push(`<button class="dl-retry" data-retry="${job.id}" type="button">Retry</button>`);
    actions.push(`<button class="dl-x" data-dismiss="${job.id}" title="Dismiss" type="button">✕</button>`);
  }
  return `<div class="dl-item${job.status === 'done' ? ' dl-done' : ''}" data-job="${job.id}">
    <div class="dl-thumb">${thumb}</div>
    <div class="dl-meta"><div class="dl-title">${title}</div>${sub}${bar}</div>
    <div class="dl-actions">${actions.join('')}</div>
  </div>`;
}

function wireDlList() {
  els.dlList.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await apiJson(`/api/youtube/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }); } catch { }
    fetchDlJobs();
  }));
  els.dlList.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    dlJobs.delete(b.dataset.dismiss);
    renderDlManager();
  }));
  els.dlList.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const job = dlJobs.get(b.dataset.retry);
    if (!job) return;
    dlJobs.delete(job.id);
    try {
      await apiJson('/api/youtube/download', { method: 'POST', body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${job.videoId}` }) });
    } catch (err) {
      toast(`Retry failed: ${err.message}`, 'warn');
    }
    fetchDlJobs();
  }));
  els.dlList.querySelectorAll('.dl-item.dl-done').forEach((el) => el.addEventListener('click', () => {
    const job = dlJobs.get(el.dataset.job);
    if (!job || !job.song) return;
    const rec = songs.find((s) => s.cloudId === job.song.id);
    if (rec) playSongFromCurrentContext(rec);
  }));
}

async function mergeDownloadedSong(cs) {
  if (!cs) return;
  if (songs.some(s => s.cloudId === cs.id || s.id === cs.id)) return;
  const rec = {
    id: 'cl_' + cs.id,
    cloudId: cs.id,
    title: cs.title,
    artist: cs.artist,
    album: cs.album,
    art: cs.art,
    duration: cs.duration,
    size: cs.size,
    hash: cs.hash,
    source: cs.source || '',
    blob: null,
    url: cs.url,
    addedAt: cs.addedAt || Date.now(),
  };
  songs.push(rec);
  await putSong(rec);
  renderView();
}

/* ---------------- Playlist modal / confirm ---------------- */

let modalRenameId = null;

function openPlaylistModal(suggestedName = '', renameId = null) {
  modalRenameId = renameId || null;
  els.modalWrap.classList.add('open');
  els.modalTitle.textContent = modalRenameId ? 'Rename playlist' : (pendingPickerSongId ? 'New playlist & add track' : 'Create playlist');
  if (els.modalCreate) els.modalCreate.textContent = modalRenameId ? 'Rename' : 'Create playlist';
  els.modalName.value = suggestedName;
  els.modalName.focus();
}

async function submitPlaylistModal() {
  const name = els.modalName.value.trim() || 'My Playlist';
  if (modalRenameId) {
    const p = playlists.find(x => x.id === modalRenameId);
    if (p) {
      p.name = name;
      await putPlaylist(p);
      pushPlaylistsSoon();
      toast(`Renamed to “${name}”`);
      renderView();
    }
    closeModal();
    return;
  }
  const p = { id: generateId(), name, songIds: [], createdAt: Date.now() };
  const pickerSong = pendingPickerSongId ? songs.find(s => s.id === pendingPickerSongId) : null;
  pendingPickerSongId = null;
  if (pickerSong) {
    const ref = await ensureCloudSong(pickerSong) || (!me ? pickerSong.id : null);
    if (ref) p.songIds.push(ref);
  }
  playlists.push(p);
  await storePlaylist(p);
  closeModal();
  renderView();
  toast(`Playlist “${name}” created`);
}

async function storePlaylist(p) {
  await putPlaylist(p);
  pushPlaylistsSoon();
}

function closeModal() {
  els.modalWrap.classList.remove('open');
  els.modalName.value = '';
  modalRenameId = null;
  if (els.modalCreate) els.modalCreate.textContent = 'Create playlist';
}

function confirmDialog(title, sub) {
  return new Promise((resolve) => {
    els.confirmWrap.classList.add('open');
    els.confirmTitle.textContent = title;
    els.confirmSub.textContent = sub;
    const done = (val) => {
      els.confirmWrap.classList.remove('open');
      els.confirmOk.onclick = null;
      els.confirmCancel.onclick = null;
      els.confirmWrap.querySelector('.modal-backdrop').onclick = null;
      resolve(val);
    };
    els.confirmOk.onclick = () => done(true);
    els.confirmCancel.onclick = () => done(false);
    els.confirmWrap.querySelector('.modal-backdrop').onclick = () => done(false);
  });
}

/* ---------------- Toasts ---------------- */

function toast(msg, kind = 'ok', duration = 2600) {
  const t = document.createElement('div');
  t.setAttribute('role', 'alert');
  t.setAttribute('aria-live', 'polite');
  t.className = 'toast' + (kind === 'warn' ? ' toast-warn' : '');
  t.innerHTML = kind === 'ok'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  t.appendChild(document.createTextNode(msg));
  els.toastRoot.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 350);
  }, duration);
}

/* ---------------- User menu ---------------- */

function openUserMenu(anchor) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu user-menu';
  const stats = offlineStats();
  const cloudCount = songs.filter(s => s.cloudId).length;
  const usedBytes = stats.bytes;
  const fmtSize = fmtBytes;
  const head = me
    ? `<div class="user-menu-head"><div class="user-avatar big">${escapeHtml((me.name || me.email || '?').charAt(0).toUpperCase())}</div><div style="min-width:0"><div class="user-name">${escapeHtml(me.name || 'Account')}</div><div class="user-sub">${escapeHtml(me.email || '')}</div></div></div>`
    : `<div class="user-menu-head"><div class="user-avatar big">J</div><div><div class="user-name">Offline</div><div class="user-sub">This device only</div></div></div>`;
  menu.innerHTML = `
    ${head}
    <div class="ctx-divider"></div>
    <div class="user-stats">Tracks <b>${songs.length}</b> (cloud <b>${cloudCount}</b>)&nbsp;·&nbsp;Playlists <b>${playlists.length}</b>&nbsp;·&nbsp;Offline <b>${stats.count}</b> (<b>${fmtSize(usedBytes)}</b>)${me ? `&nbsp;·&nbsp;Server <b>${fmtSize(serverLib.bytes)}</b> (<b>${serverLib.count}</b> tracks)` : ''}</div>
    <div class="user-stats sub">${me ? `Server box holds ${fmtSize(serverLib.bytes)} of your tracks. ` : ''}Songs are stored on your server and streamed or cached per device.</div>
    <div class="ctx-divider"></div>
    <button class="ctx-item" id="offlineSettingsBtn">Offline &amp; storage</button>
    ${me ? '<button class="ctx-item" id="signOutBtn">Sign out</button>' : (authAvailable ? '<button class="ctx-item" id="signInBtn">Sign in / Create account</button>' : '')}
    ${me && me.role === 'admin' ? '<button class="ctx-item" id="serverSettingsBtn">Server settings</button>' : ''}
    <button class="ctx-item danger" id="clearAllBtn">${me ? 'Clear this device' : 'Clear all data'}</button>`;
  positionMenu(menu, anchor);
  const signOut = menu.querySelector('#signOutBtn');
  if (signOut) signOut.addEventListener('click', async () => {
    menu.remove();
    const ok = await confirmDialog('Sign out?', 'Cloud songs stay on the server. Offline copies stored on this device are kept.');
    if (!ok) return;
    setSignedOut(true);
    toast('Signed out');
  });
  const signIn = menu.querySelector('#signInBtn');
  if (signIn) signIn.addEventListener('click', () => { menu.remove(); openAuthModal(); });
  const srvBtn = menu.querySelector('#serverSettingsBtn');
  if (srvBtn) srvBtn.addEventListener('click', () => { menu.remove(); openServerSettings(); });
  const offlineBtn = menu.querySelector('#offlineSettingsBtn');
  if (offlineBtn) offlineBtn.addEventListener('click', () => { menu.remove(); openOfflineSettings(); });
  menu.querySelector('#clearAllBtn').addEventListener('click', async () => {
    menu.remove();
    const ok = await confirmDialog(me ? 'Clear this device?' : 'Clear all data?', me
      ? 'Removes everything cached on this device. Cloud tracks remain on the server and will re-sync when you pull.'
      : 'This deletes every track, playlist and setting stored on this device.');
    if (!ok) return;
    if (audioEngine) audioEngine.pause();
    isPlaying = false;
    updatePlayIcon();
    clearInterval(progressInterval);
    currentSong = null;
    songs = [];
    playlists = [];
    queue = [];
    queueIndex = -1;
    await saveQueueRecord().catch(() => {});
    await clearAllStores();
    els.playerTitle.textContent = 'Select a song';
    els.playerArtist.textContent = 'No track playing';
    setThumb(null);
    setView('home');
    toast('Device cleared');
  });
}

async function clearAllStores() {
  for (const store of [STORE_SONGS, STORE_PLAYLISTS, STORE_QUEUE, STORE_SETTINGS]) {
    await tx(store, 'readwrite', (s) => s.clear());
  }
}

/* ---------------- Setup wizard (first run, admin) ---------------- */

function buildOverlay(innerHtml) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap open';
  wrap.innerHTML = `<div class="modal-backdrop"></div><div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(wrap);
  return wrap;
}

function openSetupWizard() {
  if (document.getElementById('setupWrap')) return;
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap open';
  wrap.id = 'setupWrap';
  wrap.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><div class="modal-title">Set up your server</div></div>
      <div class="confirm-sub">One-time setup. Enter the setup code shown in the terminal where the server is running, then create the admin account.</div>
      <input type="text" class="modal-input setup-code" id="setupCode" placeholder="Setup code (from the server terminal)" autocomplete="off" spellcheck="false">
      <input type="text" class="modal-input" id="setupName" placeholder="Your name" autocomplete="name">
      <input type="email" class="modal-input" id="setupEmail" placeholder="Email" autocomplete="email">
      <input type="password" class="modal-input" id="setupPass" placeholder="Password (min 8 characters)" autocomplete="new-password">
      <div class="auth-error" id="setupError"></div>
      <div class="modal-actions">
        <button class="primary-btn" id="setupGo">Create account</button>
      </div>
      <div class="setup-hint">After this, everything else — Google/GitHub sign-in, limits, style — you can manage in the app under Server settings.</div>
    </div>`;
  document.body.appendChild(wrap);
  const codeEl = wrap.querySelector('#setupCode');
  const nameEl = wrap.querySelector('#setupName');
  const emailEl = wrap.querySelector('#setupEmail');
  const passEl = wrap.querySelector('#setupPass');
  const errEl = wrap.querySelector('#setupError');
  const goEl = wrap.querySelector('#setupGo');
  setTimeout(() => codeEl.focus(), 60);
  const submit = async () => {
    errEl.textContent = '';
    const code = codeEl.value.trim();
    const email = emailEl.value.trim();
    const pass = passEl.value;
    if (!code || !email || !pass) { errEl.textContent = 'Fill in all fields'; return; }
    if (pass.length < 8) { errEl.textContent = 'Password must be at least 8 characters'; return; }
    goEl.disabled = true;
    try {
      await apiJson('/api/setup/complete', {
        method: 'POST',
        body: JSON.stringify({ code, email, password: pass, name: nameEl.value.trim() }),
      });
      wrap.remove();
      await afterAuthFlow(email, false);
      if (me.role === 'admin') openServerSettings();
    } catch (err) {
      errEl.textContent = err.message;
      goEl.disabled = false;
    }
  };
  goEl.addEventListener('click', submit);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

/* ---------------- Server settings (admin, in-app) ---------------- */

async function openServerSettings() {
  if (!me || me.role !== 'admin') { toast('Admin only', 'warn'); return; }
  let s;
  let users;
  try {
    [s, users] = await Promise.all([
      apiJson('/api/admin/settings'),
      apiJson('/api/admin/users'),
    ]);
  } catch (err) {
    toast(err.message, 'warn');
    return;
  }
  const originHint = `${location.origin}${APP_BASE}/auth/google/callback and ${location.origin}${APP_BASE}/auth/github/callback`;
  const fld = (label, k, type = 'text') =>
    `<div class="settings-row"><label>${label}</label><input type="${type}" class="modal-input" data-k="${k}" spellcheck="false"></div>`;
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap open';
  wrap.id = 'serverWrap';
  wrap.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal modal-wide" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="modal-title">Server settings</div>
        <button class="icon-btn modal-close" id="srvClose" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="srv-providers">
        <span class="chip ${s.providers.google ? 'ok' : ''}">Google ${s.providers.google ? 'connected' : 'not set up'}</span>
        <span class="chip ${s.providers.github ? 'ok' : ''}">GitHub ${s.providers.github ? 'connected' : 'not set up'}</span>
      </div>
      <div class="srv-section">Basics</div>
      ${fld('Server name (shown in the app)', 'serverName')}
      ${fld('Public address users open in a browser', 'publicOrigin')}
      ${fld('Max upload size per song, MB', 'maxUploadMb', 'number')}
      <div class="settings-row inline"><label>Allow people to create accounts</label><input type="checkbox" id="srvReg" ${s.registrationOpen ? 'checked' : ''}></div>
      <div class="settings-row inline"><label>Secure cookies (only when behind HTTPS)</label><input type="checkbox" id="srvSecure" ${s.secureCookies ? 'checked' : ''}></div>
      <div class="srv-section">Google sign-in</div>
      ${fld('Client ID', 'googleClientId')}
      ${fld('Client secret', 'googleClientSecret', 'password')}
      <div class="srv-section">GitHub sign-in</div>
      ${fld('Client ID', 'githubClientId')}
      ${fld('Client secret', 'githubClientSecret', 'password')}
      <div class="srv-hint">To enable Google/GitHub sign-in, create an OAuth app on their console and paste the ID + secret here. Add these redirect URIs:<br><span class="copy-uri" id="srvUri">${originHint}</span></div>
      <div class="srv-section">People</div>
      <div class="srv-users" id="srvUsers"></div>
      <div class="auth-error" id="srvError"></div>
      <div class="modal-actions">
        <button class="ghost-btn" id="srvCancel">Close</button>
        <button class="primary-btn" id="srvSave">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const val = (k) => wrap.querySelector(`[data-k="${k}"]`);
  wrap.querySelector('[data-k="serverName"]').value = s.serverName || '';
  wrap.querySelector('[data-k="publicOrigin"]').value = s.publicOrigin || '';
  wrap.querySelector('[data-k="maxUploadMb"]').value = s.maxUploadMb || 500;
  wrap.querySelector('[data-k="googleClientId"]').value = s.googleClientId || '';
  wrap.querySelector('[data-k="googleClientSecret"]').value = s.googleClientSecret || '';
  wrap.querySelector('[data-k="githubClientId"]').value = s.githubClientId || '';
  wrap.querySelector('[data-k="githubClientSecret"]').value = s.githubClientSecret || '';

  const usersBox = wrap.querySelector('#srvUsers');
  usersBox.innerHTML = users.users.map(u => `
    <div class="srv-user">
      <div class="user-avatar small">${escapeHtml((u.name || u.email || '?').charAt(0).toUpperCase())}</div>
      <div class="srv-user-info"><div class="srv-user-name">${escapeHtml(u.name || u.email)}${u.role === 'admin' ? ' <span class="chip">admin</span>' : ''}</div><div class="srv-user-sub">${escapeHtml(u.email)} · ${u.songs} songs · ${u.provider === 'password' ? 'email' : escapeHtml(u.provider)}</div></div>
      <button class="ghost-btn small danger srv-remove ${u.role === 'admin' ? 'disabled' : ''}" data-id="${u.id}" ${u.role === 'admin' ? 'disabled' : ''}>Remove</button>
    </div>`).join('');

  const close = () => wrap.remove();
  wrap.querySelector('#srvClose').addEventListener('click', close);
  wrap.querySelector('#srvCancel').addEventListener('click', close);
  wrap.querySelector('.modal-backdrop').addEventListener('click', close);

  usersBox.querySelectorAll('.srv-remove').forEach(b => b.addEventListener('click', async () => {
    if (b.classList.contains('disabled')) return;
    const id = b.getAttribute('data-id');
    const u = users.users.find(x => String(x.id) === id);
    const ok = await confirmDialog(`Remove ${u.name || u.email}?`, 'Their songs, playlists and settings on the server are removed permanently.');
    if (!ok) return;
    try {
      await apiJson(`/api/admin/users/${id}`, { method: 'DELETE' });
      b.closest('.srv-user').remove();
      toast('User removed');
    } catch (err) { toast(err.message, 'warn'); }
  }));

  wrap.querySelector('#srvUri').addEventListener('click', () => {
    navigator.clipboard.writeText(originHint).then(() => toast('Redirect URIs copied')).catch(() => {});
  });

  wrap.querySelector('#srvSave').addEventListener('click', async () => {
    const errEl = wrap.querySelector('#srvError');
    errEl.textContent = '';
    const saveBtn = wrap.querySelector('#srvSave');
    saveBtn.disabled = true;
    try {
      await apiJson('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({
          serverName: val('serverName').value.trim(),
          publicOrigin: val('publicOrigin').value.trim() || s.publicOrigin,
          maxUploadMb: parseInt(val('maxUploadMb').value, 10) || 500,
          registrationOpen: wrap.querySelector('#srvReg').checked,
          secureCookies: wrap.querySelector('#srvSecure').checked,
          googleClientId: val('googleClientId').value.trim(),
          googleClientSecret: val('googleClientSecret').value.trim(),
          githubClientId: val('githubClientId').value.trim(),
          githubClientSecret: val('githubClientSecret').value.trim(),
        }),
      });
      close();
      toast('Server settings saved');
      const cfg = await fetch(api('/api/auth/config'), { credentials: 'same-origin' }).then(r => r.json());
      providers = cfg.providers || providers;
      authConfig.serverName = cfg.serverName || '';
      authConfig.registrationOpen = cfg.registrationOpen !== false;
      updateAuthUi();
    } catch (err) {
      errEl.textContent = err.message;
      saveBtn.disabled = false;
    }
  });
}/* ---------------- Auth modal ---------------- */

let authMode = 'login';

function openAuthModal() {
  if (!authAvailable) { toast('Start the sync server (node server.js) to use accounts', 'warn'); return; }
  authMode = 'login';
  els.authWrap.classList.add('open');
  setAuthMode('login');
  setTimeout(() => els.authEmail.focus(), 50);
}

function setAuthMode(mode) {
  authMode = mode;
  els.authTitle.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  els.authGo.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  els.authSwitch.textContent = mode === 'login' ? 'New here? Create account' : 'Have an account? Sign in';
  els.authPass.placeholder = mode === 'login' ? 'Password' : 'Password (min 8 characters)';
  els.authError.textContent = '';
  if (els.authSub) {
    els.authSub.textContent = mode === 'login'
      ? 'Sign in to keep your music on every device.'
      : 'Your music syncs through your server.';
  }
  if (els.oauthRow) {
    els.oauthRow.style.display = (mode === 'login' && (providers.google || providers.github)) ? '' : 'none';
    els.authGoogle.style.display = providers.google ? '' : 'none';
    els.authGithub.style.display = providers.github ? '' : 'none';
  }
}

function closeAuthModal() {
  els.authWrap.classList.remove('open');
  els.authError.textContent = '';
}

async function submitAuth(e) {
  e.preventDefault();
  const email = els.authEmail.value.trim();
  const password = els.authPass.value;
  if (!email || !password) { els.authError.textContent = 'Fill in email and password'; return; }
  els.authGo.disabled = true;
  els.authError.textContent = '';
  try {
    if (authMode === 'login') await login(email, password);
    else {
      if (password.length < 8) { els.authError.textContent = 'Password must be at least 8 characters'; els.authGo.disabled = false; return; }
      await register(email, password, email.split('@')[0]);
    }
    closeAuthModal();
  } catch (err) {
    els.authError.textContent = err.message;
  } finally {
    els.authGo.disabled = false;
  }
}

/* ---------------- Playback from context ---------------- */

async function playSongFromCurrentContext(song) {
  if (currentSong && currentSong.id === song.id) {
    if (isPlaying) pauseAudio();
    else await playAudio();
    return;
  }
  const list = currentSongList();
  const idx = list.findIndex(s => s.id === song.id);
  if (idx === -1) {
    setQueue([song], 0);
    await loadSong(song, true);
    return;
  }
  setQueue(list, idx);
  await loadSong(list[idx], true);
}

/* ---------------- Keyboard ---------------- */

function onKeyDown(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === ' ') { e.preventDefault(); playPause(); }
  else if (e.key === 'ArrowRight' && currentSong && playbackDuration()) {
    if (audioEngine) audioEngine.seek(Math.min(playbackDuration(), audioEngine.getCurrentTime() + 5));
  }
  else if (e.key === 'ArrowLeft' && currentSong && playbackDuration()) {
    if (audioEngine) audioEngine.seek(Math.max(0, audioEngine.getCurrentTime() - 5));
  }
  else if (e.key === 'Escape') {
    closeNowPlaying();
    closeMenus();
    const srv = document.getElementById('serverWrap');
    if (srv) srv.remove();
    const setup = document.getElementById('setupWrap');
    if (setup && me) setup.remove();
  }
}

/* ---------------- Init ---------------- */

async function init() {
  ['player', 'playerTitle', 'playerArtist', 'playerInfo', 'playerThumb', 'playerThumbImg', 'playerThumbFallback', 'playerProgressWrap', 'playerProgressFill', 'playerCurrent', 'playerDuration',
    'btnPlay', 'playIcon', 'btnPrev', 'btnNext', 'btnShuffle', 'btnRepeat', 'btnMute', 'volumeWrap', 'volumeFill', 'volumeKnob',
    'userBtn', 'playerUserAvatar', 'offlineBadge', 'searchInput', 'npOverlay', 'npClose', 'npArtImg', 'npArtFallback', 'npTitle', 'npArtist', 'npProgressWrap', 'npProgressFill', 'npCurrent', 'npDuration', 'npShuffle', 'npPrev', 'npPlay', 'npPlayIcon', 'npNext', 'npRepeat', 'modalWrap', 'modalTitle', 'modalName', 'modalCreate',
    'addMusicSide',
    'modalCancel', 'modalClose', 'confirmWrap', 'confirmTitle', 'confirmSub', 'confirmOk', 'confirmCancel',
    'toastRoot', 'viewRoot', 'createPlaylist',
    'authBtn', 'authWrap', 'authTitle', 'authSub', 'authEmail', 'authPass', 'authError', 'authGo', 'authSwitch', 'authClose', 'authForm',
    'authGoogle', 'authGithub',
    'ytWrap', 'ytInput', 'ytPreview', 'ytError', 'ytDetect', 'ytSongWrap', 'ytSongList', 'ytSongCount', 'ytSelectAll', 'ytSelectNone', 'ytDownload', 'ytCancel', 'ytClose',
    'ytSrcPlaylists', 'ytSrcLiked', 'ytSrcHint', 'ytPlWrap', 'ytPlList',
    'dlManager', 'dlPill', 'dlPillLabel', 'dlPillFill', 'dlPanel', 'dlList'
  ].forEach(id => { els[id] = document.getElementById(id); });

  // Offline: reopen the last signed-in account's local DB instead of guest,
  // so the user sees their own music and not another user's / guest data.
  let initialOwner = 'guest';
  if (!navigator.onLine) {
    try { initialOwner = localStorage.getItem('ms_last_owner') || 'guest'; } catch { initialOwner = 'guest'; }
  }
  await openDB(dbNameFor(initialOwner));
  dbOwner = initialOwner;
  await loadSettings();

  const [storedSongs, storedPlaylists, queueRec] = await Promise.all([getAllSongs(), getAllPlaylists(), loadQueueRecord()]);
  songs = storedSongs || [];
  playlists = (storedPlaylists || []).sort((a, b) => b.createdAt - a.createdAt);

  document.querySelectorAll('.nav-item').forEach(n => n.addEventListener('click', () => setView(n.dataset.nav)));
  document.querySelectorAll('.mobile-tabs .tab').forEach(n => n.addEventListener('click', () => {
    if (n.dataset.tab === 'create') openPlaylistModal();
    else setView(n.dataset.tab);
  }));
  if (els.createPlaylist) els.createPlaylist.addEventListener('click', () => openPlaylistModal());

  const debouncedRender = debounce(() => { renderView(); }, 160);
  els.searchInput.addEventListener('input', (e) => {
    searchTerm = e.target.value.trim();
    debouncedRender();
  });

  const addMusicBar = document.getElementById('addMusicBar');
  if (addMusicBar) addMusicBar.addEventListener('click', () => openAddMusic(addMusicBar));
  if (els.addMusicSide) els.addMusicSide.addEventListener('click', () => openAddMusic(els.addMusicSide));

  if (els.ytClose) els.ytClose.addEventListener('click', closeYtModal);
  if (els.ytCancel) els.ytCancel.addEventListener('click', closeYtModal);
  if (els.ytWrap) {
    const ytBackdrop = els.ytWrap?.querySelector('.modal-backdrop');
    if (ytBackdrop) ytBackdrop.addEventListener('click', closeYtModal);
  }
  if (els.ytInput) {
    els.ytInput.addEventListener('input', ytPreviewSoon);
    els.ytInput.addEventListener('keydown', (e) => {
      // Textarea now: Enter adds a new line (for pasting many links);
      // Ctrl/Cmd+Enter starts. For a single pasted link, plain Enter works too.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || ytInputMode(els.ytInput.value) === 'single')) {
        e.preventDefault();
        if (ytState === 'ready') startYtDownload();
        else if (els.ytInput.value.trim()) resolveYtPreview();
      }
    });
  }
  if (els.ytDownload) els.ytDownload.addEventListener('click', startYtDownload);
  if (els.ytSrcPlaylists) els.ytSrcPlaylists.addEventListener('click', loadMyPlaylists);
  if (els.ytSrcLiked) els.ytSrcLiked.addEventListener('click', loadLiked);
  if (els.ytSelectAll) els.ytSelectAll.addEventListener('click', () => {
    if (!ytPick) return;
    ytPick.selected = new Set(ytPick.entries.map((e) => e.videoId));
    renderYtSongList();
  });
  if (els.ytSelectNone) els.ytSelectNone.addEventListener('click', () => {
    if (!ytPick) return;
    ytPick.selected = new Set();
    renderYtSongList();
  });
  if (els.dlPill) els.dlPill.addEventListener('click', (e) => {
    e.stopPropagation();
    els.dlPanel.hidden = !els.dlPanel.hidden;
  });
  if (els.dlManager) document.addEventListener('click', (e) => {
    if (!els.dlManager.hidden && !e.target.closest('.dl-manager')) els.dlPanel.hidden = true;
  });

  if (els.userBtn) els.userBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.querySelector('.user-menu')) { closeMenus(); return; }
    if (!me) {
      if (authAvailable) openAuthModal();
      else openUserMenu(els.userBtn);
      return;
    }
    openUserMenu(els.userBtn);
  });
  if (els.playerUserAvatar) els.playerUserAvatar.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.querySelector('.user-menu')) { closeMenus(); return; }
    if (!me) {
      if (authAvailable) openAuthModal();
      else openUserMenu(els.playerUserAvatar);
      return;
    }
    openUserMenu(els.playerUserAvatar);
  });

  if (els.authBtn) els.authBtn.addEventListener('click', openAuthModal);
  if (els.authForm) els.authForm.addEventListener('submit', submitAuth);
  if (els.authSwitch) els.authSwitch.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
  if (els.authClose) els.authClose.addEventListener('click', closeAuthModal);
  if (els.authWrap) els.authWrap.querySelector('.modal-backdrop')?.addEventListener('click', closeAuthModal);
  const oauthGo = (p) => {
    window.location.href = api(`/auth/${p}`);
  };
  if (els.authGoogle) els.authGoogle.addEventListener('click', () => oauthGo('google'));
  if (els.authGithub) els.authGithub.addEventListener('click', () => oauthGo('github'));

  els.modalCreate.addEventListener('click', () => submitPlaylistModal());
  els.modalCancel.addEventListener('click', closeModal);
  els.modalClose.addEventListener('click', closeModal);
  els.modalWrap?.querySelector('.modal-backdrop')?.addEventListener('click', closeModal);
  els.modalName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPlaylistModal();
    if (e.key === 'Escape') closeModal();
  });

  els.btnPlay.addEventListener('click', playPause);
  if (els.playerThumb) els.playerThumb.addEventListener('click', openNowPlaying);
  if (els.playerInfo) els.playerInfo.addEventListener('click', (e) => {
    if (e.target.closest('#playerProgressWrap')) return;
    openNowPlaying();
  });
  if (els.player) els.player.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('#playerProgressWrap') || e.target.closest('#volumeWrap') || e.target.closest('.player-controls')) return;
    if (e.target.closest('#playerThumb') || e.target.closest('#playerInfo')) return; // already handled
    openNowPlaying();
  });
  if (els.npClose) els.npClose.addEventListener('click', closeNowPlaying);
  if (els.npShuffle) els.npShuffle.addEventListener('click', toggleShuffle);
  if (els.npPrev) els.npPrev.addEventListener('click', prevSong);
  if (els.npPlay) els.npPlay.addEventListener('click', playPause);
  if (els.npNext) els.npNext.addEventListener('click', nextSong);
  if (els.npRepeat) els.npRepeat.addEventListener('click', toggleRepeat);
  if (els.npProgressWrap) els.npProgressWrap.addEventListener('click', (e) => {
    if (!currentSong) return;
    const rect = els.npProgressWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = playbackDuration();
    if (dur > 0 && audioEngine) audioEngine.seek(pct * dur);
  });
  els.btnPrev.addEventListener('click', prevSong);
  els.btnNext.addEventListener('click', nextSong);
  els.btnShuffle.addEventListener('click', toggleShuffle);
  els.btnRepeat.addEventListener('click', toggleRepeat);
  els.btnMute.addEventListener('click', toggleMute);

  // AudioEngine handles ended/repeat via onEnded callback

  let seeking = false;
  const seekPreview = (clientX) => {
    const rect = els.playerProgressWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    els.playerProgressFill.style.width = `${pct * 100}%`;
    els.playerCurrent.textContent = formatTime(pct * playbackDuration());
    return pct;
  };
  els.playerProgressWrap.addEventListener('pointerdown', (e) => {
    if (!currentSong) return;
    seeking = true;
    els.playerProgressWrap.setPointerCapture(e.pointerId);
    seekPreview(e.clientX);
  });
  els.playerProgressWrap.addEventListener('pointermove', (e) => { if (seeking) seekPreview(e.clientX); });
  els.playerProgressWrap.addEventListener('pointerup', (e) => {
    if (!seeking) return;
    seeking = false;
    const pct = seekPreview(e.clientX);
    if (audioEngine) audioEngine.seek(pct * playbackDuration());
  });

  els.volumeWrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = els.volumeWrap.getBoundingClientRect();
    const apply = (ev) => {
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      setVolume(pct, false); // no disk/network writes while dragging
    };
    apply(e);
    const up = () => {
      window.removeEventListener('pointermove', apply);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      els.volumeWrap.removeEventListener('lostpointercapture', up);
      setVolume(volume, true); // persist once on release
    };
    try { els.volumeWrap.setPointerCapture(e.pointerId); } catch { /* synthetic or invalid pointer — fall back to window listeners */ }
    window.addEventListener('pointermove', apply);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    els.volumeWrap.addEventListener('lostpointercapture', up);
  });

  els.btnShuffle.classList.toggle('active', shuffle);
  els.btnRepeat.classList.toggle('active', repeatMode !== 'off');
  els.btnRepeat.classList.toggle('one', repeatMode === 'one');
  if (audioEngine) {
    audioEngine.setVolume(volume);
    audioEngine.setMuted(isMuted);
  }
  els.volumeFill.style.width = `${volume * 100}%`;
  els.volumeKnob.style.left = `${volume * 100}%`;
  updateMuteVisual();

  if (queueRec && Array.isArray(queueRec.ids)) {
    queue = queueRec.ids.map(id => songs.find(s => s.id === id)).filter(Boolean);
    if (queue.length && typeof queueRec.index === 'number' && queueRec.index >= 0 && queueRec.index < queue.length) {
      queueIndex = queueRec.index;
      const st = queue[queueIndex];
      els.playerTitle.textContent = st.title;
      els.playerArtist.textContent = `${st.artist} — ${st.album}`;
      setThumb(st);
      els.playerDuration.textContent = st.duration ? formatTime(st.duration) : '--:--';
    }
  } else {
    setQueue(songs, 0, false);
  }

  updateOfflineBadge();
  renderView();
  fetchDlJobs();

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('online', () => {
    updateOfflineBadge();
    refreshLibraryAfterSync();
    schedulePrefetch(3);
    if (view === 'offline') renderView();
  });
  window.addEventListener('offline', () => {
    updateOfflineBadge();
    if (view === 'offline') renderView();
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('.ctx-menu') || e.target.closest('.icon-btn') || e.target.closest('#userBtn') || e.target.closest('#playerUserAvatar')) return;
    closeMenus();
  }, true);

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      if (reg.sync) {
        reg.sync.register('flush-library').catch(() => {});
      }
      if ('periodicSync' in reg) {
        try {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'granted') {
            await reg.periodicSync.register('refresh-library', { minInterval: 6 * 60 * 60 * 1000 });
          }
        } catch { /* periodic sync not granted */ }
      }
    } catch (err) {
      console.warn('SW registration failed', err);
    }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'SYNC_NOW') refreshLibraryAfterSync();
      if (e.data && e.data.type === 'AUDIO_STATS') {
        window.__audioCacheStats = e.data;
        if (view === 'offline') refreshOfflineStorage();
      }
    });
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => playAudio());
      navigator.mediaSession.setActionHandler('pause', pauseAudio);
      navigator.mediaSession.setActionHandler('nexttrack', () => nextSong());
      navigator.mediaSession.setActionHandler('previoustrack', () => prevSong());
      // Track controls here; remove Safari's default 10-second seek actions.
      for (const action of ['seekbackward', 'seekforward']) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* unsupported */ }
      }
    } catch (err) { /* unsupported */ }
  }

  if (IS_IOS) {
    setTimeout(() => toast('iOS: Add to Home Screen for full-screen playback and background audio.', 'ok', 8000), 2000);
  }

  await initAuth();
}

document.addEventListener('DOMContentLoaded', init);
