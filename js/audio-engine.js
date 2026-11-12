'use strict';

/*
 * Dual-deck playback engine for My Spotify (2026-10-22).
 *
 * Drop-in replacement for the previous effects-graph engine, exposing the
 * same window.AudioEngine API the app uses — but playback runs on two
 * plain HTMLAudioElement "decks" (current + preloaded next) instead of a
 * decoded-buffer graph. The phone's OS treats a media element as a real
 * music player: it keeps playing with the screen locked / app in the
 * background and hooks into the lock-screen (Media Session) controls.
 * There is no web-audio graph here at all, so there is nothing for the
 * OS to suspend. EQ calls are kept as harmless no-op stubs (Josh doesn't
 * use EQ; background reliability wins).
 *
 * Volume model: the user volume lives on the engine (this.volume) and is
 * applied to whichever deck is live; a crossfade is just the two decks'
 * element volumes ramping in opposite directions.
 */

class AudioEngine {
  constructor() {
    this.currentSong = null;
    this.nextSong = null;
    this.nextBuffer = null; // truthy (the armed deck's element) when a next track is preloaded
    this.volume = 0.8;
    this.isMuted = false;
    this.savedVolume = 0.8;
    this.replayGain = 1.0;
    this.crossfadeDuration = 3; // seconds
    this.eqEnabled = false;
    this.eqPreset = 'flat';
    this.onEnded = null;
    this.onTimeUpdate = null;
    this.onError = null;
    this.displayDuration = null; // app-provided () => seconds; the lock-screen position uses the same duration the UI shows
    this._eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    this._fade = null; // { outDeck, inDeck, startedAt, durMs, outStart, timer }
    this._pendingPreload = null;
    this._progressTimer = null;

    this._cur = this._makeDeck();
    this._nxt = this._makeDeck();
  }

  /* ---------------- decks ---------------- */

  _makeDeck() {
    const el = new Audio();
    el.preload = 'auto';
    el.playsInline = true;
    const deck = { el, song: null, endedFired: false, stallTimer: null, loadResolve: null, loadReject: null };

    el.addEventListener('ended', () => {
      if (deck !== this._cur || deck.endedFired) return;
      if (this._fade && this._fade.outDeck === deck) return; // old deck finishing during a fade
      deck.endedFired = true;
      this._syncMediaState();
      if (this.onEnded) {
        try { this.onEnded(); } catch (e) { /* app callback */ }
      }
    });
    el.addEventListener('timeupdate', () => {
      if (deck !== this._cur) return;
      this._emitTimeUpdate();
      // Safety net: if a fade's timer got throttled (background tab), the
      // playing deck's own clock still advances — finish the fade off it.
      if (this._fade && this._fade.inDeck === deck && el.currentTime > this._fade.durMs / 1000 + 0.75) {
        this._finishFade();
      }
    });
    el.addEventListener('play', () => { if (deck === this._cur) { this._startProgress(); this._syncMediaState(); } });
    el.addEventListener('pause', () => { if (deck === this._cur) this._syncMediaState(); });
    el.addEventListener('error', () => {
      const err = el.error ? new Error('Audio error ' + el.error.code + (el.error.message ? ': ' + el.error.message : '')) : new Error('Audio error');
      if (deck.loadReject) {
        const reject = deck.loadReject;
        deck.loadResolve = deck.loadReject = null;
        reject(err);
        return;
      }
      if (deck === this._nxt) {
        // A preloaded next track that fails to load must not be swapped in
        // later: the swap would "succeed" on a dead deck and wedge the
        // queue on a track that never plays and never ends.
        this.nextSong = null;
        this.nextBuffer = null;
        deck.song = null;
        return;
      }
      if (deck === this._cur && this.currentSong && this.onError) {
        try { this.onError(err); } catch (e) { /* app callback */ }
        // Don't leave the lock screen showing "playing" on a dead track.
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; } catch (e) {}
      }
    });
    el.addEventListener('canplay', () => {
      if (deck.loadResolve) {
        const resolve = deck.loadResolve;
        deck.loadResolve = deck.loadReject = null;
        resolve();
      }
    });
    el.addEventListener('stalled', () => {
      if (deck !== this._cur || el.paused) return;
      if (deck.stallTimer) return;
      deck.stallTimer = setTimeout(() => {
        deck.stallTimer = null;
        if (deck === this._cur && !el.paused && el.readyState < 3 && this.onError) {
          try { this.onError(new Error('Playback stalled')); } catch (e) { /* app callback */ }
        }
      }, 5000);
    });
    return deck;
  }

  _effectiveVolume() {
    if (this.isMuted) return 0;
    return Math.max(0, Math.min(1, this.volume * this.replayGain));
  }

  _applyVolume(deck) {
    if (this._fade && (deck === this._fade.inDeck || deck === this._fade.outDeck)) return; // ramp owns it
    try { deck.el.volume = this._effectiveVolume(); } catch (e) { /* iOS: element volume is read-only, harmless */ }
  }

  _applyVolumes() {
    this._applyVolume(this._cur);
    if (this._nxt && this._nxt.song) this._applyVolume(this._nxt);
  }

  /* ---------------- loading / transport ---------------- */

  async load(song) {
    if (!song) throw new Error('No song');
    const url = song.url || song.blobUrl;
    if (!url) throw new Error('No audio source');

    this._cancelFade();
    // Reuse the preloaded deck if it's armed with this very song — and the
    // preload actually succeeded (a failed preload leaves el.error set).
    if (this._nxt && this._nxt.song && song.id && this._nxt.song.id === song.id && !this._nxt.el.error) {
      const old = this._cur;
      try { old.el.pause(); } catch (e) {}
      this._cur = this._nxt;
      this._nxt = old;
      this._clearDeck(old);
      this.currentSong = song;
      this.nextSong = null;
      this.nextBuffer = null;
      const el = this._cur.el;
      this._cur.song = song;
      this._cur.endedFired = false;
      try { el.currentTime = 0; } catch (e) {}
      this._applyVolume(this._cur);
      if (song.replayGain) this.setReplayGain(song.replayGain.gainDb);
      this._emitTimeUpdate();
      await this.resume();
      return;
    }

    if (this._nxt && this._nxt.song && (!song.id || this._nxt.song.id !== song.id)) this._clearNext();

    const deck = this._cur;
    try { deck.el.pause(); } catch (e) {}
    deck.song = song;
    deck.endedFired = false;
    if (deck.stallTimer) { clearTimeout(deck.stallTimer); deck.stallTimer = null; }
    this.currentSong = song;
    if (song.replayGain) this.setReplayGain(song.replayGain.gainDb);
    const el = deck.el;
    this._applyVolume(deck);

    const ready = new Promise((resolve, reject) => {
      deck.loadResolve = resolve;
      deck.loadReject = reject;
    });
    // Don't hang forever on a slow network: settle on loadedmetadata too,
    // and give up (resolve, playback will buffer) after 15s rather than
    // wedging the app's load flow.
    const meta = new Promise((resolve) => {
      const onMeta = () => { el.removeEventListener('loadedmetadata', onMeta); resolve(); };
      el.addEventListener('loadedmetadata', onMeta);
      setTimeout(resolve, 15000);
    });

    if (el.getAttribute('src') !== url) el.src = url;
    el.load();
    try { el.currentTime = 0; } catch (e) { /* not seekable yet */ }
    this._emitTimeUpdate();
    // The old engine started playback as part of load(); the app calls
    // resume() right after for autoplay. A rejected play() here (no user
    // gesture yet) is fine — resume() will retry it.
    try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* resume() retries */ }
    try {
      await Promise.race([ready, meta]);
    } finally {
      deck.loadResolve = deck.loadReject = null;
    }
  }

  preloadNext(song) {
    if (!song) return;
    const url = song.url || song.blobUrl;
    if (!url) return;
    if (this.currentSong && song.id && this.currentSong.id === song.id) return;
    if (this._fade) { this._pendingPreload = song; return; } // arm it when the fade settles
    if (this.nextSong && song.id && this.nextSong.id === song.id && this._nxt.song === this.nextSong) return;

    const deck = this._nxt;
    deck.song = song;
    deck.endedFired = false;
    this.nextSong = song;
    this.nextBuffer = deck.el;
    this._applyVolume(deck);
    if (deck.el.getAttribute('src') !== url) deck.el.src = url;
    deck.el.preload = 'auto';
    try { deck.el.load(); } catch (e) { /* best effort */ }
  }

  playNext(opts = {}) {
    const inDeck = this._nxt;
    if (!this.nextSong || !inDeck || !inDeck.song || !inDeck.el.getAttribute('src')) return false;
    const crossfade = opts.fade === true;
    this._cancelFade(); // Next mashed mid-fade: settle the old fade before starting a new one
    const outDeck = this._cur;
    const song = this.nextSong;

    this._cur = inDeck;
    this._nxt = outDeck;
    this.currentSong = song;
    this.nextSong = null;
    this.nextBuffer = null;
    inDeck.song = song;
    inDeck.endedFired = false;
    if (song.replayGain) this.setReplayGain(song.replayGain.gainDb);

    const el = inDeck.el;
    try { el.currentTime = 0; } catch (e) {}
    try { const p = el.play(); if (p && p.catch) p.catch((err) => { if (this.onError) { try { this.onError(err); } catch (e) {} } }); } catch (e) {}

    const target = this._effectiveVolume();
    let fadeSec = 0;
    if (crossfade) {
      fadeSec = Math.max(0, Number(this.crossfadeDuration) || 0);
      const outEl = outDeck.el;
      const outDur = isFinite(outEl.duration) && outEl.duration > 0
        ? outEl.duration
        : (outDeck.song && outDeck.song.duration) || 0;
      if (outDur > 0) fadeSec = Math.max(0, Math.min(fadeSec, outDur - (outEl.currentTime || 0)));
    }
    const durMs = fadeSec * 1000;
    if (durMs > 0 && !outDeck.el.paused && !document.hidden) {
      // Crossfade: in-deck ramps 0 -> target, out-deck ramps down -> 0,
      // then the out deck is paused and parked as the next preload deck.
      try { inDeck.el.volume = 0; } catch (e) {}
      const outStart = (() => { try { return outDeck.el.volume; } catch (e) { return target; } })();
      const fade = { outDeck, inDeck, startedAt: Date.now(), durMs, outStart, timer: null };
      this._fade = fade;
      fade.timer = setInterval(() => {
        if (this._fade !== fade) { clearInterval(fade.timer); return; } // superseded
        const p = Math.min(1, (Date.now() - fade.startedAt) / fade.durMs);
        const t = this._effectiveVolume();
        try { inDeck.el.volume = t * p; } catch (e) {}
        try { outDeck.el.volume = fade.outStart * (1 - p); } catch (e) {}
        if (p >= 1) this._finishFade();
      }, 50);
    } else {
      // No fade (crossfade off, old deck already paused, or page hidden
      // where timers throttle): snap straight to final state.
      try { inDeck.el.volume = target; } catch (e) {}
      try { outDeck.el.pause(); } catch (e) {}
      this._parkDeck(outDeck);
    }
    this._startProgress();
    this._emitTimeUpdate();
    this._syncMediaState();
    return true;
  }

  pause() {
    this._finishFade();
    try { this._cur.el.pause(); } catch (e) {}
    this._syncMediaState();
  }

  async resume() {
    const el = this._cur.el;
    if (!el.getAttribute('src')) return;
    try {
      await el.play();
    } catch (e) {
      console.warn('resume failed:', e && e.message);
    }
    this._startProgress();
    this._syncMediaState();
  }

  seek(seconds) {
    const el = this._cur.el;
    if (!el.getAttribute('src')) return;
    const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : (this.currentSong && this.currentSong.duration) || 0;
    const t = Math.max(0, dur > 0 ? Math.min(seconds, Math.max(dur - 0.05, 0)) : seconds);
    try { el.currentTime = t; } catch (e) { /* not seekable yet */ }
    if (!dur || t < dur - 0.3) this._cur.endedFired = false;
    this._emitTimeUpdate();
  }

  stop() {
    this._cancelFade();
    for (const deck of [this._cur, this._nxt]) {
      try { deck.el.pause(); } catch (e) {}
      this._clearDeck(deck);
    }
    this.currentSong = null;
    this.nextSong = null;
    this.nextBuffer = null;
    this._stopProgress();
  }

  destroy() {
    this.stop();
  }

  /* ---------------- state getters ---------------- */

  getCurrentTime() {
    return this._cur.el.currentTime || 0;
  }

  getDuration() {
    const d = this._cur.el.duration;
    if (isFinite(d) && d > 0) return d;
    return (this.currentSong && this.currentSong.duration) || 0;
  }

  /* ---------------- volume / gain ---------------- */

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.volume > 0) this.isMuted = false;
    this._applyVolumes();
  }

  setMuted(muted) {
    this.isMuted = !!muted;
    if (this.isMuted) this.savedVolume = this.volume || this.savedVolume;
    this._applyVolumes();
  }

  setReplayGain(gainDb) {
    this.replayGain = Math.pow(10, (gainDb || 0) / 20);
    this._applyVolumes();
  }

  /* ---------------- EQ / analyser compat stubs ---------------- */

  setEqEnabled(enabled) { this.eqEnabled = !!enabled; }
  setEqGains(gains) { if (Array.isArray(gains)) this._eqGains = gains.slice(0, 10); while (this._eqGains.length < 10) this._eqGains.push(0); }
  getEqGains() { return this._eqGains.slice(0, 10); }
  getAnalyserData() { return null; }

  /* ---------------- internals ---------------- */

  _clearDeck(deck) {
    deck.song = null;
    deck.endedFired = false;
    deck.loadResolve = deck.loadReject = null;
    if (deck.stallTimer) { clearTimeout(deck.stallTimer); deck.stallTimer = null; }
    try { deck.el.removeAttribute('src'); deck.el.load(); } catch (e) { /* empty deck */ }
  }

  _clearNext() {
    if (this._nxt) this._clearDeck(this._nxt);
    this.nextSong = null;
    this.nextBuffer = null;
  }

  _parkDeck(deck) {
    try { deck.el.pause(); } catch (e) {}
    try { deck.el.currentTime = 0; } catch (e) {}
    this._applyVolume(deck); // ready to be armed as the next preload deck
  }

  _cancelFade() {
    if (!this._fade) return;
    const fade = this._fade;
    this._fade = null;
    if (fade.timer) clearInterval(fade.timer);
    try { fade.outDeck.el.pause(); } catch (e) {}
    this._applyVolume(fade.inDeck);
    this._flushPendingPreload();
  }

  _finishFade() {
    if (!this._fade) return;
    const fade = this._fade;
    this._fade = null;
    if (fade.timer) clearInterval(fade.timer);
    try { fade.inDeck.el.volume = this._effectiveVolume(); } catch (e) {}
    this._parkDeck(fade.outDeck);
    this._flushPendingPreload();
  }

  _flushPendingPreload() {
    if (!this._pendingPreload) return;
    const song = this._pendingPreload;
    this._pendingPreload = null;
    this.preloadNext(song);
  }

  _startProgress() {
    if (this._progressTimer) return;
    this._progressTimer = setInterval(() => {
      const el = this._cur.el;
      if (el.paused || el.ended) { this._stopProgress(); return; }
      this._emitTimeUpdate();
    }, 250);
  }

  _stopProgress() {
    if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
  }

  _emitTimeUpdate() {
    if (this.onTimeUpdate) {
      try { this.onTimeUpdate(this.getCurrentTime(), this.getDuration()); } catch (e) { /* app callback */ }
    }
    this._syncPositionState();
  }

  _syncMediaState() {
    try {
      if ('mediaSession' in navigator) {
        const el = this._cur.el;
        navigator.mediaSession.playbackState = el.getAttribute('src') && !el.paused && !el.ended ? 'playing' : 'paused';
      }
    } catch (e) { /* unsupported */ }
  }

  _syncPositionState() {
    try {
      if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
        const el = this._cur.el;
        let dur = this.getDuration();
        if (this.displayDuration) {
          try { const d = this.displayDuration(); if (d > 0) dur = d; } catch (e) { /* fall back to reported */ }
        }
        if (dur > 0 && isFinite(dur)) {
          navigator.mediaSession.setPositionState({
            duration: dur,
            playbackRate: el.playbackRate || 1,
            position: Math.min(Math.max(el.currentTime || 0, 0), dur),
          });
        }
      }
    } catch (e) { /* unsupported */ }
  }
}

const PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bassBoost: [6, 4, 2, 1, 0, 0, 0, 0, 0, 0],
  vocal: [0, 0, 1, 2, 3, 4, 3, 2, 1, 0],
  trebleBoost: [0, 0, 0, 0, 0, 1, 2, 4, 6, 8],
  rock: [4, 3, 2, 1, 0, 0, 1, 2, 3, 4],
  electronic: [5, 3, 1, 0, 0, 0, 1, 2, 3, 4],
  classical: [0, 0, 1, 2, 3, 3, 2, 1, 0, 0],
  pop: [2, 1, 1, 0, 0, 1, 1, 2, 2, 2]
};

window.AudioEngine = AudioEngine;
window.EQ_PRESETS = PRESETS;
