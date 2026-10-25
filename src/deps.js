// Managed helper binaries (yt-dlp, ffmpeg) live in <config>/bin next to the AppImage, never inside it, so they can be updated.
// No Electron imports here on purpose: this module is testable with plain node.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const UA = { 'User-Agent': 'SLYTP' };
const YTDLP_REPO = 'yt-dlp/yt-dlp';
// Static ffmpeg+ffprobe builds, tried in order. Smaller one first (~42MB download, ~150MB installed).
const FFMPEG_SOURCES = [
  { url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz', algo: 'md5', sums: (u) => u + '.md5', members: ['*/ffmpeg', '*/ffprobe'], strip: 1 },
  { url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz', algo: 'sha256', sums: () => 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/checksums.sha256', members: ['*/bin/ffmpeg', '*/bin/ffprobe'], strip: 2 },
];
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

// Streams url -> dest, returns the hex digest (sha256 by default) of what was written.
async function download(url, dest, onProgress, algo = 'sha256') {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash(algo);
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress && total) onProgress(got / total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return hash.digest('hex');
}

async function fetchText(url) {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
const sumFor = (sums, name) => (sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, '') === name) || [])[0];

const run = (file, args, timeout = 20000) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout.trim())));
});

// "2026.10.21" vs "2026.10.21.123456" (nightly) etc: numeric, part by part.
function isNewer(latest, current) {
  const a = latest.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function createDeps({ binDir, bundledYtdlp, readJson, writeJson, onStatus = () => {}, onFfmpegProgress = () => {} }) {
  const ytdlpPath = path.join(binDir, 'yt-dlp');
  const ffmpegPath = path.join(binDir, 'ffmpeg');
  const stateFile = path.join(binDir, 'deps.json');
  let status = { state: 'checking', version: '', message: '' };
  const setStatus = (s) => { status = { ...status, ...s }; onStatus(status); };

  // Binary SLYTP should run: managed copy > bundled seed > yt-dlp on PATH.
  const ytdlp = () => process.env.YTDLP || (fs.existsSync(ytdlpPath) ? ytdlpPath : (bundledYtdlp && fs.existsSync(bundledYtdlp) ? bundledYtdlp : 'yt-dlp'));
  const ffmpegLocation = () => (fs.existsSync(ffmpegPath) ? ffmpegPath : null);

  function seed() {
    fs.mkdirSync(binDir, { recursive: true });
    if (!fs.existsSync(ytdlpPath) && bundledYtdlp && fs.existsSync(bundledYtdlp)) {
      try { fs.copyFileSync(bundledYtdlp, ytdlpPath); fs.chmodSync(ytdlpPath, 0o755); } catch {}
    }
  }

  async function updateYtdlp({ force = false } = {}) {
    seed();
    const state = readJson(stateFile, {});
    let current = '';
    // Judge only our managed copy (seeded from the bundled one); a yt-dlp elsewhere on PATH does not count as installed.
    if (fs.existsSync(ytdlpPath) || process.env.YTDLP) { try { current = await run(ytdlp(), ['--version']); } catch {} }
    if (!force && current && Date.now() - (state.ytdlpChecked || 0) < CHECK_EVERY_MS) {
      setStatus({ state: 'ok', version: current, message: `Up to date (checked ${new Date(state.ytdlpChecked).toLocaleString()})` });
      return status;
    }
    setStatus({ state: 'checking', version: current, message: 'Checking for updates…' });
    try {
      const rel = JSON.parse(await fetchText(`https://api.github.com/repos/${YTDLP_REPO}/releases/latest`));
      const latest = rel.tag_name;
      if (!latest) throw new Error('Could not read the latest version');
      if (current && !isNewer(latest, current)) {
        writeJson(stateFile, { ...state, ytdlpChecked: Date.now() });
        setStatus({ state: 'ok', version: current, message: 'Up to date' });
        return status;
      }
      setStatus({ state: 'updating', version: current, message: `Downloading ${latest}…` });
      const base = `https://github.com/${YTDLP_REPO}/releases/download/${latest}`;
      const tmp = ytdlpPath + '.new';
      const [sums, got] = await Promise.all([fetchText(`${base}/SHA2-256SUMS`), download(`${base}/yt-dlp_linux`, tmp)]);
      const want = sumFor(sums, 'yt-dlp_linux');
      if (!want || want !== got) { fs.rmSync(tmp, { force: true }); throw new Error('Checksum mismatch, update discarded'); }
      fs.chmodSync(tmp, 0o755);
      const v = await run(tmp, ['--version'], 60000); // proves the new binary actually starts here
      fs.renameSync(tmp, ytdlpPath);
      writeJson(stateFile, { ...state, ytdlpChecked: Date.now() });
      setStatus({ state: 'ok', version: v, message: current ? `Updated from ${current}` : 'Installed' });
    } catch (e) {
      setStatus({ state: 'error', version: current, message: `Could not update: ${e.message}${current ? ' (using the installed version)' : ''}` });
    }
    return status;
  }

  // ffmpeg: only fetched on request (video merge / audio conversion).
  let installing = null;
  async function installFfmpeg() {
    if (installing) return installing;
    installing = (async () => {
      fs.mkdirSync(binDir, { recursive: true });
      const tmp = path.join(binDir, 'ffmpeg-download.part');
      let lastErr = 'unknown error';
      try {
        for (const src of FFMPEG_SOURCES) {
          try {
            const [sums, got] = await Promise.all([fetchText(src.sums(src.url)), download(src.url, tmp, onFfmpegProgress, src.algo)]);
            const want = sumFor(sums, path.basename(src.url)) || (src.algo === 'md5' ? sums.trim().split(/\s+/)[0] : '');
            if (!want || want !== got) throw new Error('Checksum mismatch, download discarded');
            onFfmpegProgress(-1); // extracting
            await run('tar', ['-xJf', tmp, '--wildcards', '--no-wildcards-match-slash', `--strip-components=${src.strip}`, '-C', binDir, ...src.members], 300000);
            fs.chmodSync(ffmpegPath, 0o755);
            await run(ffmpegPath, ['-version']);
            return { ok: true };
          } catch (e) {
            lastErr = e.code === 'ENOENT' ? 'The "tar" and "xz" tools are needed to unpack ffmpeg.' : e.message;
          }
        }
        return { ok: false, message: lastErr };
      } finally {
        fs.rmSync(tmp, { force: true });
        installing = null;
      }
    })();
    return installing;
  }

  return { ytdlp, ffmpegLocation, updateYtdlp, installFfmpeg, getStatus: () => status, seed };
}

module.exports = { createDeps, isNewer, sumFor };
