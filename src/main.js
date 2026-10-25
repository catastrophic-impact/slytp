const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, session } = require('electron');
const { spawn, execFile } = require('child_process');
const { createDeps } = require('./deps');
const fs = require('fs');
const path = require('path');

const bundledYtdlp = path.join(process.resourcesPath || '', 'bin', 'yt-dlp'); // seed copy only; the live one is config/bin/yt-dlp
const bundledFfmpeg = path.join(process.resourcesPath || '', 'bin', 'ffmpeg');
const devFfmpeg = path.join(__dirname, '..', 'build', 'ffmpeg');
// Managed ffmpeg (config/bin, downloaded on demand) > bundled > project build/ (dev) > whatever ffmpeg is on PATH.
const ffmpegArgs = () => {
  const p = [deps.ffmpegLocation(), bundledFfmpeg, devFfmpeg].find((f) => f && fs.existsSync(f));
  return p ? ['--ffmpeg-location', p] : [];
};
// Fallback only: the real fix is linux.executableArgs in package.json (this switch is applied too late to affect Chromium's sandbox).
app.commandLine.appendSwitch('no-sandbox');
// Portable: all app data (favorites, prefs, Chromium cache) lives in ./config next to the AppImage (or the project in dev), never in ~/.config.
const dataDir = process.env.APPIMAGE ? path.join(path.dirname(process.env.APPIMAGE), 'config') : path.join(__dirname, '..', 'config');
app.setPath('userData', dataDir);
const favFile = () => path.join(app.getPath('userData'), 'favorites.json');
const prefFile = () => path.join(app.getPath('userData'), 'prefs.json');
let mainWin = null;
const sendUi = (ch, payload) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, payload); };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// yt-dlp and ffmpeg are kept fresh in <config>/bin (next to the AppImage); see src/deps.js.
const deps = createDeps({
  binDir: path.join(dataDir, 'bin'),
  bundledYtdlp: app.isPackaged ? bundledYtdlp : null,
  readJson, writeJson,
  onStatus: (st) => sendUi('ytdlp-status', st),
  onFfmpegProgress: (p) => sendUi('ffmpeg-progress', p),
});
const YTDLP = () => deps.ytdlp();

function ytdlpOnce(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP(), ['-J', '--no-warnings', '--socket-timeout', '20', ...args], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}
// YouTube hiccups are common; one retry makes channel/video loads far less flaky.
async function ytdlp(args) {
  try { return await ytdlpOnce(args); }
  catch { await new Promise((r) => setTimeout(r, 800)); return ytdlpOnce(args); }
}

// On-disk cache (config/cache.json) so Home and channels show instantly; the UI refreshes in the background.
const cacheFile = () => path.join(app.getPath('userData'), 'cache.json');
let cacheData = null;
const loadCache = () => cacheData || (cacheData = readJson(cacheFile(), {}));
function cacheSet(key, value) {
  const c = loadCache();
  c[key] = { at: Date.now(), value };
  const keys = Object.keys(c);
  if (keys.length > 40) keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - 40).forEach((k) => delete c[k]);
  try { writeJson(cacheFile(), c); } catch {}
}
const cacheGet = (key) => loadCache()[key] || null;

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function mapEntry(e, fallbackChannel) {
  return {
    id: e.id,
    title: e.title,
    duration: e.duration || null,
    views: e.view_count ?? null,
    channel: e.channel || e.uploader || fallbackChannel?.name || '',
    channelUrl: e.channel_url || e.uploader_url || fallbackChannel?.url || '',
    thumb: thumb(e.id),
  };
}

function channelUrlFor(input) {
  let s = input.trim();
  if (/^@[\w.-]+$/.test(s)) s = `https://www.youtube.com/${s}`;
  s = s.replace(/\/(videos|featured|streams|shorts|playlists)\/?$/, '').replace(/\/$/, '');
  return s;
}

const chanKey = (input) => 'ch:' + channelUrlFor(input);
ipcMain.handle('channel-cached', (_e, input) => cacheGet(chanKey(input)));
const PAGE = 48;
function saveChannel(input, result) {
  cacheSet(chanKey(input), result);
  if (result.channel.url) cacheSet(chanKey(result.channel.url), result);
}
// First page (newest PAGE videos). Videos already loaded further back (infinite scroll) stay in the cache after a refresh.
ipcMain.handle('channel', async (_e, input) => {
  const base = channelUrlFor(input);
  const data = await ytdlp(['--flat-playlist', '--playlist-end', String(PAGE), `${base}/videos`]);
  const avatar = (data.thumbnails || []).find((t) => /avatar/.test(t.id || ''))?.url || null;
  const channel = {
    name: data.channel || data.uploader || data.title,
    id: data.channel_id || data.uploader_id,
    url: data.channel_url || data.uploader_url || base,
    avatar,
  };
  const videos = (data.entries || []).filter(Boolean).map((e) => mapEntry(e, channel));
  const old = cacheGet(chanKey(input))?.value;
  const ids = new Set(videos.map((v) => v.id));
  const extra = (old?.videos || []).filter((v) => !ids.has(v.id));
  const result = { channel, videos: [...videos, ...extra], done: videos.length < PAGE || !!old?.done };
  saveChannel(input, result);
  return result;
});
// Next page of older videos, appended to the cached list so scrolling back later is instant.
ipcMain.handle('channel-more', async (_e, input, offset) => {
  const base = channelUrlFor(input);
  const data = await ytdlp(['--flat-playlist', '--playlist-items', `${offset + 1}:${offset + PAGE}`, `${base}/videos`]);
  const old = cacheGet(chanKey(input))?.value;
  const channel = old?.channel || { name: data.channel || data.uploader || '', url: base };
  const ids = new Set((old?.videos || []).map((v) => v.id));
  const fresh = (data.entries || []).filter(Boolean).map((e) => mapEntry(e, channel)).filter((v) => !ids.has(v.id));
  const done = fresh.length === 0 || (data.entries || []).length < PAGE;
  if (old) saveChannel(input, { ...old, videos: [...old.videos, ...fresh], done });
  return { videos: fresh, done };
});

const unxml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

async function channelFeed(ch) {
  const id = (ch.url.match(/\/channel\/(UC[\w-]+)/) || [])[1] || ch.id;
  if (!id) return [];
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  if (!res.ok) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const g = (re) => (m[1].match(re) || [])[1];
    const vid = g(/<yt:videoId>(.*?)<\/yt:videoId>/);
    return {
      id: vid, title: unxml(g(/<title>(.*?)<\/title>/) || ''), duration: null,
      views: Number(g(/<media:statistics views="(\d+)"/)) || null,
      channel: ch.name, channelUrl: ch.url, thumb: thumb(vid),
      published: Date.parse(g(/<published>(.*?)<\/published>/)) || 0,
    };
  });
}

// The RSS feed has no video lengths. Fill them from yt-dlp's channel listings, remembering them by id so only new videos cost a lookup.
async function fillDurations(favs, videos) {
  const known = cacheGet('durations')?.value || {};
  const missing = videos.filter((v) => known[v.id] == null);
  if (missing.length) {
    const urls = [...new Set(missing.map((v) => v.channelUrl).filter(Boolean))];
    await Promise.all(urls.map((u) => ytdlpOnce(['--flat-playlist', '--playlist-end', '30', `${channelUrlFor(u)}/videos`])
      .then((d) => { for (const e of d.entries || []) if (e?.id && e.duration) known[e.id] = e.duration; }).catch(() => {})));
    const keys = Object.keys(known);
    if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete known[k]);
    cacheSet('durations', known);
  }
  for (const v of videos) v.duration = known[v.id] ?? v.duration;
}
const feedSig = (favs) => favs.map((f) => f.url).sort().join('|');
ipcMain.handle('feed-cached', (_e, favs) => {
  const c = cacheGet('home');
  return c && c.value.sig === feedSig(favs) ? { at: c.at, videos: c.value.videos, done: !!c.value.done } : null;
});
ipcMain.handle('feed', async (_e, favs) => {
  const lists = await Promise.all(favs.map((f) => channelFeed(f).catch(() => null)));
  // If every feed failed (offline), keep the cached copy instead of replacing it with nothing.
  if (lists.length && lists.every((l) => !l)) throw new Error('Could not reach YouTube.');
  const videos = lists.flatMap((l) => l || []).sort((a, b) => b.published - a.published).slice(0, 120);
  await fillDurations(favs, videos);
  // Older videos already loaded by scrolling (feed-more) stay in the list after a refresh.
  const old = cacheGet('home')?.value;
  const same = old && old.sig === feedSig(favs);
  const ids = new Set(videos.map((v) => v.id));
  const all = same ? [...videos, ...old.videos.filter((v) => !ids.has(v.id))] : videos;
  const value = { sig: feedSig(favs), videos: all, cursors: same ? old.cursors || {} : {}, done: same ? !!old.done : false };
  cacheSet('home', value);
  return { at: Date.now(), videos: all, done: value.done };
});

// Home infinite scroll. The RSS feeds only reach back ~15 videos per channel, so older ones come from yt-dlp's channel listings,
// one page per favorite per call (cursor per channel kept in the cache). Flat listings have no dates, so approximate_date is used
// (day-level for recent videos, coarser further back). Each call's batch is sorted newest-first and appended to the list.
const HOME_PAGE = 24;
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
ipcMain.handle('feed-more', async (_e, favs) => {
  const c = cacheGet('home');
  if (!c || c.value.sig !== feedSig(favs)) return { videos: [], done: true };
  const val = c.value;
  const cursors = val.cursors || {};
  const todo = favs.filter((f) => !cursors[f.url]?.done);
  if (!todo.length) { cacheSet('home', { ...val, done: true }); return { videos: [], done: true }; }
  const ids = new Set(val.videos.map((v) => v.id));
  let failed = 0;
  const batches = await pool(todo, 4, async (f) => {
    const at = cursors[f.url]?.n || 0;
    try {
      const d = await ytdlp(['--flat-playlist', '--extractor-args', 'youtubetab:approximate_date',
        '--playlist-items', `${at + 1}:${at + HOME_PAGE}`, `${channelUrlFor(f.url)}/videos`]);
      const entries = (d.entries || []).filter(Boolean);
      cursors[f.url] = { n: at + entries.length, done: entries.length < HOME_PAGE };
      return entries.map((e) => ({ ...mapEntry(e, f), channel: f.name, channelUrl: f.url, published: (e.timestamp || 0) * 1000 }));
    } catch { failed++; return []; }
  });
  if (failed === todo.length) throw new Error('Could not reach YouTube.');
  const fresh = batches.flat().filter((v) => v.id && !ids.has(v.id)).sort((a, b) => b.published - a.published);
  const done = favs.every((f) => cursors[f.url]?.done);
  cacheSet('home', { ...val, videos: [...val.videos, ...fresh], cursors, done });
  return { videos: fresh, done };
});

// Search pages: yt-dlp has no offset for ytsearch, so ask for offset+PAGE results and keep the last PAGE (capped at SEARCH_MAX).
const SEARCH_PAGE = 30, SEARCH_MAX = 300;
ipcMain.handle('search', async (_e, q, offset = 0) => {
  const end = Math.min(SEARCH_MAX, offset + SEARCH_PAGE);
  const data = await ytdlp(['--flat-playlist', '--playlist-items', `${offset + 1}:${end}`, `ytsearch${end}:${q}`]);
  const videos = (data.entries || []).filter(Boolean).map((e) => mapEntry(e));
  return { videos, done: videos.length < end - offset || end >= SEARCH_MAX };
});

const infoMemo = new Map();
async function getInfo(urlOrId) {
  const hit = infoMemo.get(urlOrId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const url = /^https?:/.test(urlOrId) ? urlOrId : `https://www.youtube.com/watch?v=${urlOrId}`;
  const d = await ytdlp(['--no-playlist', url]);
  const seen = new Map();
  for (const f of d.formats || []) {
    if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
    const key = `${f.height}${f.fps > 30 ? 'p' + Math.round(f.fps) : 'p'}`;
    if (!seen.has(key)) seen.set(key, { height: f.height, fps: f.fps || 30, label: key });
  }
  const audio = (d.formats || []).filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  const qualities = [...seen.values()].sort((a, b) => b.height - a.height || b.fps - a.fps);
  const ud = d.upload_date || '';
  const data = {
    id: d.id,
    url: d.webpage_url || url,
    title: d.title,
    duration: d.duration,
    thumb: thumb(d.id),
    channel: d.channel || d.uploader,
    channelUrl: d.channel_url || d.uploader_url,
    views: d.view_count ?? null,
    likes: d.like_count ?? null,
    uploaded: d.timestamp ? d.timestamp * 1000 : (ud ? Date.UTC(+ud.slice(0, 4), +ud.slice(4, 6) - 1, +ud.slice(6, 8)) : null),
    isLive: !!d.is_live,
    description: (d.description || '').slice(0, 5000),
    qualities,
    audioExt: audio?.audio_ext && audio.audio_ext !== 'none' ? audio.audio_ext : 'm4a',
  };
  infoMemo.set(urlOrId, { at: Date.now(), data });
  if (d.id) infoMemo.set(d.id, { at: Date.now(), data });
  return data;
}
ipcMain.handle('video-info', (_e, urlOrId) => getInfo(urlOrId));

// Prefix needed to reach host programs: distrobox box, VS Code flatpak, or none.
function hostPrefix() {
  if (fs.existsSync('/run/.containerenv') || fs.existsSync('/.dockerenv')) return ['distrobox-host-exec'];
  if (fs.existsSync('/.flatpak-info')) return ['flatpak-spawn', '--host'];
  return [];
}

function runOk(argv) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: 15000 }, (err) => resolve(!err));
  });
}

// Prefers the MPV flatpak, falls back to a native mpv. Returns the argv prefix, or null if neither exists.
async function detectMpv() {
  const pre = hostPrefix();
  if (await runOk([...pre, 'flatpak', 'info', 'io.mpv.Mpv'])) return [...pre, 'flatpak', 'run', 'io.mpv.Mpv'];
  if (await runOk([...pre, 'mpv', '--version'])) return [...pre, 'mpv'];
  return null;
}

// ---- Playback guardrails ----------------------------------------------------------------------------
// Plain `bestvideo[height<=720]` can pick a 4x-bitrate HLS (m3u8) copy of the same 720p, which many connections/CPUs
// cannot keep up with. We pin the exact height, prefer H.264 over plain HTTPS (no HLS), then VP9, and AV1 last.
// guard level (config/guard.json) rises automatically when MPV reports stutter, making the next play safer.
const guardFile = () => path.join(app.getPath('userData'), 'guard.json');
const getGuard = () => Math.min(2, Math.max(0, Number(readJson(guardFile(), { level: 0 }).level) || 0));

function ytdlFormat(height, level) {
  const h = height ? `[height=${height}]` : '';
  if (height === null) return 'bv*[protocol!*=m3u8]+ba/bv*+ba/b'; // unknown formats (e.g. live): stay loose
  const NOHLS = '[protocol!*=m3u8]';
  const fpsSets = level >= 1 ? ['[fps<=?30]', ''] : [''];
  const alts = [];
  for (const fps of fpsSets) alts.push(`bv*${h}${fps}[vcodec^=avc1]${NOHLS}+ba`);
  for (const fps of fpsSets) alts.push(`bv*${h}${fps}[vcodec^=vp9]${NOHLS}+ba`);
  alts.push(`bv*${h}[vcodec!^=av01]${NOHLS}+ba`, `bv*${h}${NOHLS}+ba`, `bv*${h}+ba`, `b${h}`, 'b');
  return alts.join('/');
}

// Queue variant: videos in a playlist differ in available heights, so use a cap ("best up to H") that each entry resolves itself.
function ytdlFormatCap(height, level) {
  const h = height ? `[height<=${height}]` : '';
  const NOHLS = '[protocol!*=m3u8]';
  const fpsSets = level >= 1 ? ['[fps<=?30]', ''] : [''];
  const alts = [];
  for (const fps of fpsSets) alts.push(`bv*${h}${fps}[vcodec^=avc1]${NOHLS}+ba`);
  for (const fps of fpsSets) alts.push(`bv*${h}${fps}[vcodec^=vp9]${NOHLS}+ba`);
  alts.push(`bv*${h}[vcodec!^=av01]${NOHLS}+ba`, `bv*${h}${NOHLS}+ba`, `bv*${h}+ba`, `b${h}`, 'b');
  return alts.join('/');
}

// Best available height not above the requested one (0 = best). Null when the video exposes no heights (live etc.).
function resolveHeight(info, want) {
  const hs = [...new Set((info?.qualities || []).map((q) => q.height))].sort((a, b) => b - a);
  if (!hs.length) return null;
  if (!want) return hs[0];
  return hs.find((x) => x <= want) || hs[hs.length - 1];
}

function mpvTuning(level) {
  const a = [
    '--hwdec=auto-safe',
    `--cache-secs=${[90, 180, 300][level]}`, `--demuxer-max-bytes=${[300, 600, 900][level]}MiB`, '--demuxer-max-back-bytes=64MiB',
    '--cache-pause-initial=yes', `--cache-pause-wait=${[3, 6, 10][level]}`,
    '--term-status-msg=SLSTAT ${=time-pos}|${=frame-drop-count}|${=decoder-frame-drop-count}|${paused-for-cache}|${hwdec-current}|${video-format}',
  ];
  if (level >= 2) a.push('--framedrop=vo', '--vd-lavc-skiploopfilter=nonref', '--vd-lavc-fast');
  return a;
}

// Resolves once MPV has opened the video (ok), exited with an error, or 45s passed (assume it is fine).
// While MPV runs we watch its status line; stutter (cache stalls / dropped frames) bumps the guard level and tells the UI.
// audio=true: stream only the best audio (no video bytes) and show the video's thumbnail as the picture.
async function bestThumb(id) {
  for (const n of ['maxresdefault', 'hqdefault']) {
    const url = `https://i.ytimg.com/vi/${id}/${n}.jpg`;
    try { if ((await fetch(url, { method: 'HEAD' })).ok) return url; } catch {}
  }
  return thumb(id);
}

ipcMain.handle('play', async (e, { id, ids, height, audio }) => {
  const mpv = await detectMpv();
  if (!mpv) return { ok: false, code: 'MPV_MISSING' };
  const level = getGuard();
  const queue = Array.isArray(ids) && ids.length > 1; // "Play all": MPV queues every entry (use < and > to skip)
  const list = queue ? ids : [id || ids?.[0]];
  const watch = (v) => `https://www.youtube.com/watch?v=${v}`;
  let args;
  if (audio) {
    args = [...mpv.slice(1), '--ytdl-format=ba/b', '--vid=1', '--force-window=yes', '--image-display-duration=inf', '--cache-pause-initial=yes',
      '--term-status-msg=SLSTAT ${=time-pos}|0|0|${paused-for-cache}|no|audio'];
    // each entry carries its own thumbnail as a file-local option
    const thumbs = await Promise.all(list.map(bestThumb));
    list.forEach((v, i) => args.push('--{', `--external-file=${thumbs[i]}`, watch(v), '--}'));
  } else if (queue) {
    args = [...mpv.slice(1), `--ytdl-format=${ytdlFormatCap(height, level)}`, ...mpvTuning(level), ...list.map(watch)];
  } else {
    let info = null;
    try { info = await getInfo(list[0]); } catch {}
    const target = resolveHeight(info, height);
    args = [...mpv.slice(1), `--ytdl-format=${ytdlFormat(target, level)}`, ...mpvTuning(level), watch(list[0])];
  }
  // Native mpv uses whatever yt-dlp is on PATH (often missing/outdated on e.g. Mint); point it at ours. The flatpak bundles its own.
  if (mpv.includes('mpv') && !mpv.includes('flatpak') && path.isAbsolute(YTDLP())) args.splice(mpv.length - 1, 0, `--script-opts=ytdl_hook-ytdl_path=${YTDLP()}`);
  return new Promise((resolve) => {
    let done = false, tail = '', buf = '';
    const st = { played: 0, drops: 0, stalls: 0, wasPaused: false, hw: '', fmt: '' };
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const child = spawn(mpv[0], args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (d) => {
      const text = d.toString();
      tail = (tail + text).slice(-1500);
      if (/\b(VO|AO):|Video --vid|Audio --aid/.test(tail)) finish({ ok: true });
      buf = (buf + text).slice(-4000);
      for (const m of buf.matchAll(/SLSTAT ([\d.]*)\|(\d*)\|(\d*)\|(\w+)\|([\w-]*)\|([\w-]*)/g)) {
        st.played = Math.max(st.played, parseFloat(m[1]) || 0);
        st.drops = Math.max(st.drops, (+m[2] || 0) + (+m[3] || 0));
        const paused = m[4] === 'yes';
        if (paused && !st.wasPaused && st.played > 4) st.stalls++;
        st.wasPaused = paused; st.hw = m[5]; st.fmt = m[6];
      }
      buf = buf.slice(buf.lastIndexOf('SLSTAT') > -1 ? buf.lastIndexOf('SLSTAT') + 6 : buf.length);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData); // keep draining so MPV never blocks on a full pipe
    child.on('error', (err) => finish({ ok: false, code: 'LAUNCH_FAILED', message: err.message }));
    child.on('exit', (code) => {
      finish(code === 0 ? { ok: true } : { ok: false, code: 'MPV_ERROR', message: tail.trim().split('\n').slice(-3).join('\n') || `MPV exited with code ${code}` });
      // Judge the session: sustained stalls, or many dropped frames relative to play time (esp. with software decoding).
      if (!audio && !queue && st.played >= 20 && level < 2) {
        const swHeavy = st.hw === 'no' && /vp9|av1|hevc/i.test(st.fmt);
        const reason = st.stalls >= 2 ? 'the network could not keep up (buffering)' : (st.drops > st.played * 2 || (swHeavy && st.drops > st.played)) ? 'your device dropped frames while decoding' : '';
        if (reason) {
          writeJson(guardFile(), { level: level + 1 });
          if (!e.sender.isDestroyed()) e.sender.send('play-report', { level: level + 1, reason });
        }
      }
    });
    const timer = setTimeout(() => finish({ ok: true }), 45000);
  });
});
ipcMain.handle('guard:get', () => getGuard());
ipcMain.handle('guard:reset', () => { writeJson(guardFile(), { level: 0 }); return 0; });

const safeName = (t) => (t || 'video').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 150) || 'video';
let downloading = false;
const hasFfmpeg = () => ffmpegArgs().length ? Promise.resolve(true) : runOk(['ffmpeg', '-version']);

// kind: 'audio' (best audio stream, untouched) | 'video' (chosen height + best audio, merged by ffmpeg).
ipcMain.handle('download', async (e, { id, title, kind, height, audioExt, format }) => {
  if (downloading) return { ok: false, message: 'A download is already running.' };
  const AUDIO = { mp3: 'mp3', vorbis: 'ogg', opus: 'opus', m4a: 'm4a', flac: 'flac', wav: 'wav' };
  const VIDEO = ['mp4', 'mkv', 'webm'];
  const reencode = kind === 'audio' && AUDIO[format] ? format : null; // null => keep YouTube's original audio stream
  const vfmt = VIDEO.includes(format) ? format : 'mp4';
  const ext = kind === 'audio' ? (reencode ? AUDIO[reencode] : (audioExt || 'm4a')) : vfmt;
  if ((kind === 'video' || reencode) && !(await hasFfmpeg())) {
    return { ok: false, code: 'FFMPEG_MISSING' };
  }
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    title: kind === 'audio' ? 'Save audio' : 'Save video',
    defaultPath: path.join(app.getPath('downloads'), `${safeName(title)}.${ext}`),
    filters: kind === 'audio' ? [{ name: 'Audio', extensions: [ext] }] : [{ name: 'Video', extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  // yt-dlp picks the real container extension, so drop the one from the dialog and let it add its own.
  const base = r.filePath.replace(/\.(mp4|mkv|webm|m4a|opus|ogg|mp3|aac|flac|wav)$/i, '');
  const H = `[height=${height}]`;
  const fmt = kind === 'audio' ? 'bestaudio/best'
    : vfmt === 'mp4' ? `bv*${H}[vcodec^=avc1]+ba[ext=m4a]/bv*${H}[vcodec!^=av01]+ba/bv*${H}+ba/b${H}` // h264+aac when available; AV1 only as a last resort (many players choke on it)
    : vfmt === 'webm' ? `bv*${H}[ext=webm]+ba[ext=webm]/bv*${H}+ba/b${H}`
    : `bv*${H}[vcodec!^=av01]+ba/bv*${H}+ba/b${H}`;
  const kindArgs = kind === 'audio' ? (reencode ? ['-x', '--audio-format', reencode, '--audio-quality', '0'] : []) : ['--merge-output-format', vfmt];
  const args = ['--no-playlist', '--no-warnings', '--newline', '-f', fmt, ...kindArgs, ...ffmpegArgs(),
    '--progress-template', 'download:SLP %(progress._percent_str)s', '--print', 'after_move:SLPFILE %(filepath)s',
    '-o', `${base}.%(ext)s`, `https://www.youtube.com/watch?v=${id}`];
  downloading = true;
  return new Promise((resolve) => {
    let file = '', tail = '';
    const child = spawn(YTDLP(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.startsWith('SLPFILE ')) file = line.slice(8).trim();
        else if (line.startsWith('SLP ')) e.sender.send('download-progress', line.slice(4).trim());
        else if (line.trim()) tail = (tail + '\n' + line).slice(-800);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { downloading = false; resolve({ ok: false, message: err.message }); });
    child.on('exit', (code) => {
      downloading = false;
      resolve(code === 0 ? { ok: true, file } : { ok: false, message: tail.trim().split('\n').slice(-3).join('\n') || `yt-dlp exited with code ${code}` });
    });
  });
});
ipcMain.handle('ytdlp:status', () => deps.getStatus());
ipcMain.handle('ytdlp:check', () => deps.updateYtdlp({ force: true }));
ipcMain.handle('ffmpeg:install', () => deps.installFfmpeg());
ipcMain.handle('show-file', (_e, f) => { shell.showItemInFolder(f); return true; });

ipcMain.handle('favorites:get', () => readJson(favFile(), []));
ipcMain.handle('favorites:set', (_e, list) => { writeJson(favFile(), list); return true; });
const plFile = () => path.join(app.getPath('userData'), 'playlists.json');
ipcMain.handle('playlists:get', () => readJson(plFile(), []));
ipcMain.handle('playlists:set', (_e, list) => { writeJson(plFile(), list); return true; });
ipcMain.handle('prefs:get', () => readJson(prefFile(), { quality: 'ask' }));
ipcMain.handle('prefs:set', (_e, p) => { writeJson(prefFile(), p); return true; });
ipcMain.handle('open-external', (_e, url) => (/^https?:\/\/[^\s]+$/i.test(url) ? shell.openExternal(url) : false));
ipcMain.handle('copy-text', (_e, t) => { clipboard.writeText(String(t)); return true; });

app.whenReady().then(async () => {
  // Lists (Home/channels/durations) are only cached within a session; favorites, playlists and prefs are kept.
  try { fs.unlinkSync(cacheFile()); } catch {}
  cacheData = {};
  // The UI is local files: never let a stale cached style.css/app.js survive an update.
  await session.defaultSession.clearCache().catch(() => {});
  const win = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#0f0f12', title: 'SLYTP',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin = win;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  deps.updateYtdlp(); // background: seeds config/bin/yt-dlp, then checks GitHub at most once a day
});
app.on('window-all-closed', () => app.quit());
