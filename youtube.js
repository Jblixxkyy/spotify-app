'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const ANDROID_VR_UA = 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; eureka-user Build/SQ3A.220605.009.A1) gzip';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const YT_TOOL_TIMEOUT_MS = 15 * 60 * 1000;

class YoutubeError extends Error {}

class DownloadCancelledError extends Error {
  constructor(msg = 'Download cancelled') {
    super(msg);
    this.name = 'DownloadCancelledError';
    this.cancelled = true;
  }
}

function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./i, '').toLowerCase();
  const v = u.searchParams.get('v');
  if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
  if (host === 'youtu.be') {
    const id = (u.pathname.split('/')[1] || '');
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function fetchWithTimeout(url, opts = {}, ms = 25000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  return res;
}

function spawnChild(cmd, args, onStdoutLine, onStderrLine, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new DownloadCancelledError()); return; }
    const isBat = /\.(bat|cmd)$/i.test(cmd);
    let child;
    try {
      child = (isBat && process.platform === 'win32')
        ? spawn('cmd.exe', ['/c', cmd, ...args], { windowsHide: true })
        : spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let timedOut = false;
    let killedByCancel = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, YT_TOOL_TIMEOUT_MS);
    const onAbort = () => { killedByCancel = true; try { child.kill('SIGKILL'); } catch { } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let outBuf = '';
    let errBuf = '';
    const feed = (buf, chunk, onLine) => {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l && onLine) onLine(l);
      return buf;
    };
    child.stdout.on('data', (d) => { outBuf = feed(outBuf, d, onStdoutLine); });
    child.stderr.on('data', (d) => { errBuf = feed(errBuf, d, onStderrLine); });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (killedByCancel) reject(new DownloadCancelledError());
      else reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (outBuf && onStdoutLine) onStdoutLine(outBuf);
      if (errBuf && onStderrLine) onStderrLine(errBuf);
      if (killedByCancel) reject(new DownloadCancelledError());
      else if (timedOut) reject(new YoutubeError('The download tool took too long and was stopped'));
      else resolve(code);
    });
  });
}

function captureTool(cmd, args) {
  return new Promise((resolve, reject) => {
    const isBat = /\.(bat|cmd)$/i.test(cmd);
    let child;
    try {
      child = (isBat && process.platform === 'win32')
        ? spawn('cmd.exe', ['/c', cmd, ...args], { windowsHide: true })
        : spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, YT_TOOL_TIMEOUT_MS);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new YoutubeError('The download tool took too long and was stopped'));
      else resolve({ code, stdout, stderr });
    });
  });
}

const toolCache = {};

function toolPath(name) {
  if (name in toolCache) return toolCache[name];
  let found = null;
  const envOverride = name === 'yt-dlp' ? process.env.YTDLP_PATH : process.env.FFMPEG_PATH;
  const local = path.join(__dirname, 'tools', process.platform === 'win32' ? `${name}.exe` : name);
  for (const candidate of [envOverride, local]) {
    if (candidate && verifyTool(candidate, name)) { found = candidate; break; }
  }
  if (!found) {
    try {
      const where = process.platform === 'win32'
        ? spawnSync('where.exe', [name], { encoding: 'utf8', timeout: 10000, windowsHide: true })
        : spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', timeout: 10000 });
      const first = where.status === 0 ? String(where.stdout || '').trim().split(/\r?\n/)[0] : '';
      if (first && verifyTool(first, name)) found = first;
    } catch { }
  }
  toolCache[name] = found;
  return found;
}

function verifyTool(p, name) {
  if (!p) return false;
  try {
    const r = spawnSync(p, name === 'ffmpeg' ? ['-version'] : ['--version'], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function extMime(ext) {
  const map = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
    webm: 'audio/webm', opus: 'audio/opus', oga: 'audio/ogg', ogg: 'audio/ogg',
    wav: 'audio/wav', flac: 'audio/flac', mka: 'audio/x-matroska',
  };
  return map[String(ext || '').toLowerCase().replace(/^\./, '')] || null;
}

function mimeExt(mime) {
  const m = extMime;
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  for (const [ext, full] of Object.entries({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', opus: 'audio/opus', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' })) {
    if (full === base) return ext;
  }
  return 'm4a';
}

function playabilityMessage(play) {
  const status = play && play.status;
  const reason = String((play && play.reason) || '');
  if (status === 'LOGIN_REQUIRED' || /sign in|confirm you('| a)re not a bot|bot/i.test(reason)) {
    return 'YouTube wants extra verification for this video. Install yt-dlp on this machine (and restart the server) to get past it.';
  }
  if (status === 'UNPLAYABLE' || status === 'ERROR') {
    return reason || 'This video cannot be played.';
  }
  if (status === 'AGE_VERIFICATION_REQUIRED' || status === 'AGE_GATE') {
    return 'This video is age-restricted and cannot be downloaded.';
  }
  return reason || `YouTube refused to play this video (${status || 'unknown'}).`;
}

async function innertubePlayer(videoId) {
  const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': ANDROID_VR_UA,
      'x-goog-api-format-version': '2',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.60.19',
          androidSdkVersion: 32,
          osName: 'Android',
          osVersion: '12',
          hl: 'en',
          gl: 'US',
        },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  }, 25000).catch((err) => {
    throw new YoutubeError(`Could not reach YouTube: ${err.message}`);
  });
  if (!res.ok) throw new YoutubeError(`YouTube did not respond (HTTP ${res.status})`);
  const body = await res.json().catch(() => null);
  if (!body) throw new YoutubeError('YouTube returned an unreadable response');
  const play = body.playabilityStatus || {};
  if (play.status !== 'OK') throw new YoutubeError(playabilityMessage(play));
  return body;
}

function pickAudioFormat(adaptiveFormats) {
  const audio = (adaptiveFormats || []).filter(
    (f) => String(f.mimeType || '').startsWith('audio/') && f.url
  );
  if (!audio.length) return null;
  const byItag = (want) => audio.find((f) => Number(f.itag) === want);
  return byItag(140) || byItag(251) || byItag(250) || byItag(249) || audio[0];
}

async function resolveWeb(videoId) {
  const body = await innertubePlayer(videoId);
  const vd = body.videoDetails || {};
  const fmt = pickAudioFormat(body.streamingData && body.streamingData.adaptiveFormats);
  const isLive = !!(body.streamingData && body.streamingData.hlsManifestUrl) && !(fmt && fmt.contentLength);
  if (!fmt) {
    if (isLive) throw new YoutubeError('Live streams cannot be downloaded.');
    throw new YoutubeError('No downloadable audio stream was returned for this video.');
  }
  return {
    videoId,
    title: String(vd.title || ''),
    channel: String(vd.author || ''),
    duration: Number(vd.lengthSeconds) || 0,
    thumbUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    via: 'builtin',
    format: {
      url: fmt.url,
      mime: String(fmt.mimeType || 'audio/mp4').split(';')[0].trim(),
      totalBytes: Number(fmt.contentLength) || 0,
    },
  };
}

async function resolveYtdlp(videoId) {
  const ytdlp = toolPath('yt-dlp');
  const { code, stdout, stderr } = await captureTool(ytdlp, [
    '--dump-single-json', '--no-playlist', '--no-warnings', '--no-progress', watchUrl(videoId),
  ]);
  if (code !== 0 || !stdout.trim()) {
    const reason = String(stderr || '').split(/\r?\n/).filter(Boolean).pop();
    throw new YoutubeError(reason ? `yt-dlp: ${reason.slice(0, 200)}` : 'yt-dlp could not read this video.');
  }
  let info;
  try { info = JSON.parse(stdout); } catch { throw new YoutubeError('yt-dlp returned unreadable info.'); }
  if (info.is_live) throw new YoutubeError('Live streams cannot be downloaded.');
  if (!info.title) throw new YoutubeError('yt-dlp found no title for this video.');
  return {
    videoId,
    title: String(info.title),
    channel: String(info.channel || info.uploader || ''),
    duration: Math.round(Number(info.duration) || 0),
    thumbUrl: String(info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`),
    via: 'ytdlp',
  };
}

async function getVideo(videoId) {
  if (toolPath('yt-dlp')) {
    try { return await resolveYtdlp(videoId); } catch (err) { if (err instanceof YoutubeError) throw err; }
  }
  return resolveWeb(videoId);
}

async function innertubeSearch(query, pageToken = null, musicOnly = true) {
  const body = {
    context: {
      // WEB client: the old ANDROID_VR client (1.60.19) now returns empty
      // search results (HTTP 200, no sections) — YouTube stopped serving it.
      client: {
        clientName: 'WEB',
        clientVersion: '2.20241126.01.00',
        hl: 'en',
        gl: 'US',
      },
    },
    query,
  };
  if (pageToken) body.params = pageToken;
  if (musicOnly) body.params = (body.params || '') + 'EgWKAQIIAWoKEAUQBRAAGA0%3D';
  const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': BROWSER_UA,
      'x-goog-api-format-version': '2',
    },
    body: JSON.stringify(body),
  }, 25000).catch((err) => {
    throw new YoutubeError(`Could not reach YouTube: ${err.message}`);
  });
  if (!res.ok) throw new YoutubeError(`YouTube did not respond (HTTP ${res.status})`);
  const data = await res.json().catch(() => null);
  if (!data) throw new YoutubeError('YouTube returned an unreadable response');
  const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const results = [];
  let nextPageToken = null;
  for (const section of contents) {
    const items = section.itemSectionRenderer?.contents || [];
    for (const item of items) {
      const video = item.videoRenderer;
      if (!video) continue;
      const videoId = video.videoId;
      if (!videoId) continue;
      const title = video.title?.runs?.[0]?.text || video.title?.simpleText || '';
      const channel = video.ownerText?.runs?.[0]?.text || video.longBylineText?.runs?.[0]?.text || '';
      const durationText = video.lengthText?.simpleText || video.lengthText?.runs?.[0]?.text || '';
      let duration = 0;
      const parts = durationText.split(':').map(Number);
      if (parts.length === 2) duration = parts[0] * 60 + parts[1];
      else if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
      const thumbUrl = video.thumbnail?.thumbnails?.[video.thumbnail.thumbnails.length - 1]?.url
        || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      results.push({ videoId, title, channel, duration, thumbUrl });
    }
    const cont = section.continuationItemRenderer;
    if (cont) nextPageToken = cont.continuationEndpoint?.continuationCommand?.token;
  }
  return { results, nextPageToken };
}

async function searchYouTube(query, limit = 20, pageToken = null) {
  const { results, nextPageToken } = await innertubeSearch(query, pageToken, true);
  return { results: results.slice(0, limit), nextPageToken };
}

async function innertubeBrowse(browseId, params = null) {
  const body = {
    context: {
      // WEB_REMIX (YouTube Music web client): FEmusic_home 400s on the old
      // ANDROID_VR client and on plain WEB — only the Music client serves it.
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20241126.01.00',
        hl: 'en',
        gl: 'US',
      },
    },
    browseId,
  };
  if (params) body.params = params;
  const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': BROWSER_UA,
      'x-goog-api-format-version': '2',
    },
    body: JSON.stringify(body),
  }, 25000).catch((err) => {
    throw new YoutubeError(`Could not reach YouTube: ${err.message}`);
  });
  if (!res.ok) throw new YoutubeError(`YouTube did not respond (HTTP ${res.status})`);
  return res.json().catch(() => null);
}

function runsText(runs) {
  return (runs || []).map((r) => r.text || '').join('');
}

function parseDurationText(text) {
  const m = /(?:^|\D)(\d{1,2}:\d{2})(?:\D|$)/.exec(String(text || ''));
  if (!m) return 0;
  const [mm, ss] = m[1].split(':').map(Number);
  return mm * 60 + ss;
}

// YouTube Music home now returns musicCarouselShelfRenderer sections
// (not musicShelfRenderer). Items are either playable songs
// (musicResponsiveListItemRenderer, e.g. "Quick picks") or playlist cards
// (musicTwoRowItemRenderer with a browseEndpoint instead of a videoId —
// those are skipped, they have nothing the result card can play).
function parseMusicCarouselShelf(section) {
  const car = section.musicCarouselShelfRenderer;
  if (!car) return null;
  const header = car.header?.musicCarouselShelfBasicHeaderRenderer?.title;
  const title = header?.runs?.[0]?.text || header?.simpleText || 'Music';
  const items = [];
  for (const entry of car.contents || []) {
    const li = entry.musicResponsiveListItemRenderer;
    if (li) {
      const videoId = li.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
        || li.navigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId) continue;
      const cols = li.flexColumns || [];
      const titleText = runsText(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
      const subText = runsText(cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
      const thumbs = li.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      items.push({
        videoId,
        title: titleText,
        channel: subText.split(' • ')[0] || '',
        duration: parseDurationText(subText),
        thumbUrl: thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      });
      continue;
    }
    const two = entry.musicTwoRowItemRenderer;
    if (two) {
      const videoId = two.navigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId) continue;
      const thumbs = two.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      items.push({
        videoId,
        title: runsText(two.title?.runs) || two.title?.simpleText || '',
        channel: two.subtitle?.runs?.[0]?.text || '',
        duration: 0,
        thumbUrl: thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      });
    }
  }
  if (!items.length) return null;
  return { title, items };
}

function parseShelfSection(section) {
  return parseMusicShelf(section) || parseMusicCarouselShelf(section);
}

function parseBrowseContents(data) {
  const shelves = [];
  const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs || [];
  for (const tab of tabs) {
    const tabRenderer = tab.tabRenderer;
    if (!tabRenderer) continue;
    const content = tabRenderer.content;
    if (!content) continue;
    const sections = content.sectionListRenderer?.contents || [];
    for (const section of sections) {
      const shelf = parseShelfSection(section);
      if (shelf) shelves.push(shelf);
    }
  }
  if (!shelves.length) {
    const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      const shelf = parseShelfSection(section);
      if (shelf) shelves.push(shelf);
    }
  }
  return shelves;
}

function parseMusicShelf(section) {
  const musicShelf = section.musicShelfRenderer;
  if (!musicShelf) return null;
  const title = musicShelf.title?.runs?.[0]?.text || musicShelf.title?.simpleText || 'Music';
  const contents = musicShelf.contents || [];
  const items = [];
  for (const item of contents) {
    const video = item.musicTwoRowItemRenderer || item.musicOneRowItemRenderer || item.gridMusicItemRenderer;
    if (!video) continue;
    let videoId = video.videoId || video.navigationEndpoint?.watchEndpoint?.videoId;
    if (!videoId) continue;
    const title = video.title?.runs?.[0]?.text || video.title?.simpleText || '';
    const subtitle = video.subtitle?.runs?.[0]?.text || video.shortBylineText?.runs?.[0]?.text || '';
    const thumbUrl = video.thumbnail?.thumbnails?.[video.thumbnail.thumbnails.length - 1]?.url
      || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    let duration = 0;
    const durText = video.durationText?.simpleText || video.durationText?.runs?.[0]?.text || '';
    const parts = durText.split(':').map(Number);
    if (parts.length === 2) duration = parts[0] * 60 + parts[1];
    else if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
    items.push({ videoId, title, channel: subtitle, duration, thumbUrl });
  }
  if (!items.length) return null;
  return { title, items };
}

async function browseYouTubeMusic() {
  // FEmusic_home rotates its shelves run to run — about half the time it
  // has no playable shelf at all (podcast/playlist carousels only). Fall
  // back to New releases, whose "Music videos" shelf is stable and full
  // of playable videos, before giving up to the frontend's search fallback.
  for (const browseId of ['FEmusic_home', 'FEmusic_new_releases']) {
    try {
      const data = await innertubeBrowse(browseId);
      if (!data) continue;
      const shelves = parseBrowseContents(data);
      if (shelves.length) return shelves;
    } catch { /* try the next browse page */ }
  }
  throw new YoutubeError('YouTube returned an unreadable response');
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadWeb(videoId, destBase, onProgress, signal) {
  if (signal && signal.aborted) throw new DownloadCancelledError();
  const info = await resolveWeb(videoId);
  if (signal && signal.aborted) throw new DownloadCancelledError();
  const destPath = `${destBase}.audio`;
  const ac = new AbortController();
  let cancelled = false;
  const onExtAbort = () => { cancelled = true; ac.abort(); };
  if (signal) signal.addEventListener('abort', onExtAbort, { once: true });
  let idleTimer = null;
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(new Error('The audio stream stalled')), 75000);
  };
  bumpIdle();
  let res;
  try {
    res = await fetch(info.format.url, {
      headers: { 'user-agent': ANDROID_VR_UA, referer: 'https://www.youtube.com/' },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onExtAbort);
    if (cancelled) throw new DownloadCancelledError();
    throw new YoutubeError(`Audio stream failed: ${err.message}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onExtAbort);
    if (cancelled) throw new DownloadCancelledError();
    throw new YoutubeError(`Audio stream failed (HTTP ${res.status})`);
  }
  const total = info.format.totalBytes || Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let size = 0;
  let lastTick = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      bumpIdle();
      size += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (onProgress && now - lastTick > 350) {
        lastTick = now;
        onProgress({ stage: 'Downloading', pct: total ? size / total : 0, bytes: size, total });
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
  } catch (err) {
    if (cancelled) throw new DownloadCancelledError();
    throw new YoutubeError(`Audio stream failed: ${err.message}`);
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onExtAbort);
  }
  if (cancelled) throw new DownloadCancelledError();
  if (total && size !== total) throw new YoutubeError('The audio download was interrupted.');
  return {
    filePath: destPath,
    size,
    sha256: hash.digest('hex'),
    mime: info.format.mime,
    ext: mimeExt(info.format.mime),
    via: 'builtin',
    info: { videoId, title: info.title, channel: info.channel, duration: info.duration, thumbUrl: info.thumbUrl },
  };
}

async function downloadYtdlp(videoId, destBase, onProgress, signal) {
  const ytdlp = toolPath('yt-dlp');
  const dir = path.dirname(destBase);
  const prefix = path.basename(destBase);
  for (const stale of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (stale.startsWith(prefix + '.')) {
      try { fs.rmSync(path.join(dir, stale), { force: true }); } catch { }
    }
  }
  // Fast path: NO ffmpeg re-encode. YouTube's own best audio (usually m4a/AAC)
  // is stored as-is — browsers play m4a natively. The old --extract-audio mp3
  // step re-encoded every song with ffmpeg, which was the slowest stage on
  // weak CPUs (and bloated files ~2x for zero audible gain).
  const args = [
    '--no-playlist', '--no-warnings', '--newline', '--no-part', '--no-mtime',
    '--concurrent-fragments', '8', '--buffer-size', '16K',
    '--http-chunk-size', '10M', '--retries', '3', '--fragment-retries', '3',
    '--write-info-json',
    '-f', 'bestaudio[ext=m4a][abr<=256]/bestaudio[ext=opus][abr<=160]/bestaudio/best',
    '-o', `${destBase}.%(ext)s`,
  ];
  args.push(watchUrl(videoId));
  let lastErr = '';
  const code = await spawnChild(ytdlp, args, (line) => {
    const m = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)(KiB|MiB|GiB)/.exec(line);
    if (m) {
      const unit = { KiB: 1024, MiB: 1048576, GiB: 1073741824 }[m[3]] || 1;
      onProgress && onProgress({
        stage: 'Downloading',
        pct: Math.min(0.98, parseFloat(m[1]) / 100),
        bytes: 0,
        total: Math.round(parseFloat(m[2]) * unit),
      });
    }
    if (/^ERROR/i.test(line)) lastErr = line.replace(/^ERROR:\s*/i, '').slice(0, 300);
  }, (l) => { if (l && !lastErr) lastErr = l.slice(0, 300); }, signal);
  if (code !== 0) throw new YoutubeError(lastErr || `yt-dlp exited with code ${code}.`);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const produced = files.find((f) => {
    if (!f.startsWith(prefix + '.')) return false;
    const e = path.extname(f).slice(1).toLowerCase();
    return e && e !== 'json' && !!extMime(e);
  });
  if (!produced) throw new YoutubeError('yt-dlp did not produce an audio file.');
  let info = null;
  const infoFile = files.find((f) => f === prefix + '.info.json');
  if (infoFile) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, infoFile), 'utf8'));
      info = {
        videoId,
        title: String(j.title || ''),
        channel: String(j.channel || j.uploader || ''),
        duration: Math.round(Number(j.duration) || 0),
        thumbUrl: String(j.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`),
      };
    } catch { }
    try { fs.rmSync(path.join(dir, infoFile), { force: true }); } catch { }
  }
  const filePath = path.join(dir, produced);
  const stat = fs.statSync(filePath);
  const ext = path.extname(produced).slice(1).toLowerCase();
  let replayGain = { gainDb: 0, peakDb: 1 };
  try {
    replayGain = await normalizeAudio(filePath);
  } catch { }
  return {
    filePath,
    size: stat.size,
    sha256: await hashFile(filePath),
    mime: extMime(ext) || 'audio/mpeg',
    ext,
    via: 'ytdlp',
    info,
    replayGain,
  };
}

async function normalizeAudio(filePath) {
  const ffmpeg = toolPath('ffmpeg');
  if (!ffmpeg) return { gainDb: 0, peakDb: 1 };
  try {
    const { stdout } = await captureTool(ffmpeg, [
      '-i', filePath,
      '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
      '-f', 'null', '-',
    ]);
    const jsonStart = stdout.lastIndexOf('{');
    const jsonEnd = stdout.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      return { gainDb: 0, peakDb: 1 };
    }
    const data = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
    const inputI = Number(data.input_i);
    const inputTp = Number(data.input_tp);
    const inputLra = Number(data.input_lra);
    const targetOffset = Number(data.target_offset);
    if (!isFinite(inputI) || !isFinite(targetOffset)) return { gainDb: 0, peakDb: 1 };
    const gainDb = -targetOffset;
    const peakDb = isFinite(inputTp) ? inputTp : 1;
    return { gainDb, peakDb };
  } catch {
    return { gainDb: 0, peakDb: 1 };
  }
}

async function downloadAudio(videoId, destBase, onProgress, signal) {
  if (toolPath('yt-dlp')) {
    try { return await downloadYtdlp(videoId, destBase, onProgress, signal); }
    catch (err) { if (err instanceof YoutubeError || err instanceof DownloadCancelledError) throw err; }
  }
  return downloadWeb(videoId, destBase, onProgress, signal);
}

async function fetchThumbnailDataUrl(videoId, maxBytes = 380000) {
  for (const name of ['maxresdefault', 'hqdefault']) {
    try {
      const res = await fetchWithTimeout(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`, {
        headers: { 'user-agent': BROWSER_UA },
      }, 20000);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) continue;
      if (buf.length > maxBytes) continue;
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch { }
  }
  return '';
}

function parseTitleInto(rawTitle, channel) {
  const original = String(rawTitle || '').trim();
  let title = original;
  title = title.replace(/\s*[([]\s*(?:[a-z0-9'’\- ]{0,12}?\s)?(?:official\s+)?(?:music\s+|lyrics?\s*|audio\s+|video\s+|hd\s*|4k\s*|hq\s*)?(?:video|audio|lyrics?|visualizer|visualiser|remaster(?:ed)?|explicit|clean version|full song|hq|hd|4k|mv)\b[^)\]]{0,24}[)\]]\s*/gi, '');
  title = title.replace(/\s*[([][^)\]]{0,24}\b(?:video|audio|lyrics?|visualizer)\b[^)\]]{0,24}[)\]]\s*/gi, '');
  title = title.replace(/\s*[-–—|]\s*(?:the\s+)?official\s+(?:music\s+)?(?:video|audio|lyrics?)\s*$/i, '');
  title = title.replace(/\s{2,}/g, ' ').replace(/\s*[-–—|:]\s*$/, '').trim();
  let artist = String(channel || '').replace(/\s*-\s*Topic$/i, '').trim();
  let songTitle = title || original;
  const dash = songTitle.match(/^(.{1,60}?)\s+[-–—]\s+(.{1,140})$/);
  if (dash && !/^(official|video|audio|lyrics?|new|full)$/i.test(dash[1].trim())) {
    artist = dash[1].trim();
    songTitle = dash[2].trim();
  }
  return {
    title: songTitle || original || 'Unknown Title',
    artist: artist || 'Unknown Artist',
    album: 'YouTube',
  };
}

/* ---------------- Playlists & bulk ---------------- */

function extractPlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^PL[a-zA-Z0-9_-]{10,}$/.test(s) || /^(?:OL|UU|LL|RD|FL)[a-zA-Z0-9_-]{8,}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const list = u.searchParams.get('list');
  if (list && /^[a-zA-Z0-9_-]{8,}$/.test(list)) return list;
  const m = u.pathname.match(/^\/playlist\/?$/);
  return m && list ? list : null;
}

function extractAllVideoIds(text) {
  const out = [];
  const seen = new Set();
  const push = (id) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
  const s = String(text || '');
  for (const m of s.matchAll(/[?&]v=([a-zA-Z0-9_-]{11})\b/g)) push(m[1]);
  for (const m of s.matchAll(/youtu\.be\/([a-zA-Z0-9_-]{11})\b/g)) push(m[1]);
  for (const m of s.matchAll(/\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})\b/g)) push(m[1]);
  if (!out.length) { const single = extractVideoId(s); if (single) push(single); }
  return out;
}

async function listPlaylist(playlistIdOrUrl, limit = 500) {
  const ytdlp = toolPath('yt-dlp');
  if (!ytdlp) throw new YoutubeError('Bulk playlist import needs yt-dlp on the server (single-song downloads still work without it).');
  const raw = String(playlistIdOrUrl || '').trim();
  const pid = extractPlaylistId(raw) || raw;
  // Radio mixes (RD…) can't be read from the /playlist page — YouTube calls
  // them "unviewable" there — but the watch URL they rode in on (watch?v=…&
  // list=RD…) extracts as the full mix. So keep the original URL when we
  // have one; only synthesize the playlist URL from a bare id.
  const url = /^https?:\/\//i.test(raw) && /[?&]list=/.test(raw)
    ? raw
    : `https://www.youtube.com/playlist?list=${encodeURIComponent(pid)}`;
  // RD radio mixes are endless related-video chains (one test mix flattened
  // to 472 tracks) — YouTube itself only presents ~50 as "the mix", so cap
  // RD imports there. Real playlists keep the caller's limit.
  const effectiveLimit = /^RD/i.test(pid) ? Math.min(limit, 50) : limit;
  const { code, stdout, stderr } = await captureTool(ytdlp, [
    '--flat-playlist', '--dump-single-json', '--no-warnings', '--no-progress',
    '--playlist-end', String(Math.max(1, Math.min(1000, effectiveLimit))), url,
  ]);
  if (code !== 0 || !stdout.trim()) {
    const reason = String(stderr || '').split(/\r?\n/).filter(Boolean).pop();
    throw new YoutubeError(reason ? `yt-dlp: ${reason.slice(0, 200)}` : 'Could not read that playlist (is it public or unlisted?).');
  }
  let info;
  try { info = JSON.parse(stdout); } catch { throw new YoutubeError('yt-dlp returned unreadable playlist info.'); }
  const entries = (info.entries || [])
    .filter((e) => e && /^[a-zA-Z0-9_-]{11}$/.test(String(e.id || '')))
    .map((e) => ({
      videoId: String(e.id),
      title: String(e.title || ''),
      channel: String(e.channel || e.uploader || ''),
      duration: Math.round(Number(e.duration) || 0),
    }));
  return {
    playlistId: pid,
    title: String(info.title || 'YouTube playlist'),
    count: entries.length,
    entries,
  };
}

module.exports = {
  YoutubeError,
  DownloadCancelledError,
  extractVideoId,
  extractPlaylistId,
  extractAllVideoIds,
  listPlaylist,
  watchUrl,
  getVideo,
  downloadAudio,
  normalizeAudio,
  fetchThumbnailDataUrl,
  parseTitleInto,
  toolPath,
  searchYouTube,
  innertubeSearch,
  browseYouTubeMusic,
};
