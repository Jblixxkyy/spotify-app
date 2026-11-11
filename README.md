# My Spotify

A self-hosted, zero-dependency music streaming PWA. Import music from YouTube (single tracks, links, or whole playlists), upload your own audio files, then stream them to any browser — with full **offline playback** on your phone once installed as a PWA.

- **No npm packages.** The entire server is one file (`server.js`) built on Node's built-in modules (`http`, `sqlite`, `crypto`).
- **YouTube integration**: search, browse, single downloads, playlist bulk import, liked-songs / your-playlists import via Google OAuth.
- **Offline-first**: service worker caches the app shell and up to ~600 MB of audio for playback with no connection.
- **Multi-user**: first account becomes the admin; friends/family can register their own libraries (registrations can be closed in admin settings).
- **Docker or bare Node**, your choice.

---

## Quick start (Node)

Requirements: **Node 22.5 or newer** (uses the built-in `node:sqlite`; Node 24 recommended). No other installs needed for basic use.

```bash
git clone https://github.com/Jblixxkyy/spotify-app.git
cd spotify-app
node server.js
```

Windows: double-click `start.bat` instead. (First time on Windows? Run `setup-windows.bat` once to fetch `yt-dlp` — see below.)

1. The terminal prints a **first-run setup code** like `ABC-1234`.
2. Open `http://localhost:8378` — a setup wizard pops up automatically.
3. Enter the code + your name/email/password → your account is created **as the admin**.

That's it. YouTube search, single-song downloads, and local file uploads all work out of the box.

## Quick start (Docker)

```bash
git clone https://github.com/Jblixxkyy/spotify-app.git
cd spotify-app
docker compose up -d
```

The image ships with **yt-dlp and ffmpeg preinstalled** — playlist imports work immediately. Data persists in the bind-mounted `./data` folder. Then do the same setup-code wizard at `http://localhost:8378`.

> Tip: `docker compose restart` after editing source files — the server loads code once at startup.

## Windows extras

| Script | What it does |
|---|---|
| `start.bat` | Launch the server |
| `setup-windows.bat` | Downloads the current `yt-dlp.exe` into `tools\` (enables playlist imports + bot-checked videos) |

ffmpeg is optional on all platforms — it only enables ReplayGain loudness normalization; downloads succeed without it.

---

## Optional: full feature unlock

### yt-dlp (recommended)
Needed for **playlist/bulk imports** and for the occasional video where YouTube demands extra verification (the error message will tell you).

- Docker: already included.
- Windows: run `setup-windows.bat`, or `winget install yt-dlp.yt-dlp`.
- Linux/macOS: install `yt-dlp` on your PATH, or set `YTDLP_PATH`.

If you add or change yt-dlp after the server started, **restart the server** (tool lookup is cached).

### Google OAuth (optional)
Unlocks **Google sign-in** and importing **your liked songs / your YouTube Music playlists**.

1. Admin → **Server settings** → set **Public address** to the URL users actually visit (default `http://localhost:8378`).
2. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an OAuth client with redirect URI `{public address}/auth/google/callback` and the scope `youtube.readonly`.
3. Paste the Client ID + Secret into Server settings.

### GitHub OAuth (optional)
Same idea, redirect URI `{public address}/auth/github/callback`.

### HTTPS / remote access
The server itself speaks plain HTTP — put it behind a reverse proxy (Caddy, nginx, Cloudflare Tunnel…) for TLS, then enable **Secure cookies** in Server settings. PWA install + offline caching require HTTPS (or plain localhost).

---

## Environment variables (all optional)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8378` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `PUBLIC_ORIGIN` | from admin settings | Base URL used to build OAuth redirect URIs |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from admin settings | Google OAuth (env overrides the UI) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from admin settings | GitHub OAuth (env overrides the UI) |
| `YTDLP_PATH` / `FFMPEG_PATH` | auto-discovered | Explicit tool paths |
| `YT_MAX_CONCURRENT` | `6` | Max parallel YouTube download jobs (1–12) |
| `SETUP_CODE` | random, printed to terminal | Pre-set the first-run admin code |

Everything else (server name, upload limit, open/closed registration, OAuth keys) is editable in-app under **Admin → Server settings** and stored in the SQLite database — no config files, no secrets in code.

## Security notes

- The server binds `0.0.0.0` by default and YouTube search/browse endpoints are open — don't expose the port to the internet casually; use a reverse proxy with auth if you must.
- All per-user data lives in `data/` (SQLite + audio files). Back that folder up and keep it private.

## Project layout

```
server.js          Single-file Node server (API, auth, streaming, download jobs)
youtube.js         YouTube helper (search, yt-dlp downloads, InnerTube fallback)
sw.js              Service worker (offline shell + audio cache + background sync)
js/app.js          Frontend app (views, library, uploads, sync queue)
js/audio-engine.js Dual-deck audio playback (crossfade, MediaSession)
data/              Created at runtime — SQLite DB + audio blobs (gitignored)
```
