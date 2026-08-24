#!/usr/bin/env node
/*
 * Download static ffmpeg.exe + ffprobe.exe for the current platform.
 *
 * Bundled into the Windows installer via electron-builder's `extraResources`,
 * so end users don't need any pre-installed tooling.
 *
 * Sources (tried in order, first success wins):
 *   1. gyan.dev Windows essentials ZIP   (Windows only)
 *   2. BtbN/FFmpeg-Builds GitHub release (cross-platform fallback)
 *   3. System PATH (skip download entirely)
 *
 * Idempotent: if resources/ffmpeg.exe (or platform equivalent) already exists,
 * the script exits 0 without re-downloading.
 *
 * Usage:  node scripts/download-ffmpeg.js
 * Env:    FFMPEG_VERSION  override gyan.dev version (default: latest known)
 *         FFMPEG_URL      override download URL entirely
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');

const PLATFORM = process.platform;     // 'win32' | 'linux' | 'darwin'
const ARCH     = process.arch;          // 'x64' | 'arm64'
const RESOURCES = path.join(__dirname, '..', 'resources');

const EXE_NAME = PLATFORM === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const PROBE_NAME = PLATFORM === 'win32' ? 'ffprobe.exe' : 'ffprobe';

// ----- gyan.dev Windows essentials (ZIP) -----
const GYAN_VERSION = process.env.FFMPEG_VERSION || '9.0.1';
const GYAN_URL = `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${GYAN_VERSION}-essentials_build.zip`;
const GYAN_SHA_URL = `https://www.gyan.dev/ffmpeg/builds/packages/.ffmpeg-${GYAN_VERSION}-essentials_build.zip.sha256`;

// ----- BtbN cross-platform fallback -----
const BTBN_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const BTBN_ASSET = PLATFORM === 'win32'
  ? 'ffmpeg-master-latest-win64-gpl.zip'
  : PLATFORM === 'darwin'
    ? 'ffmpeg-master-latest-macos64-gpl.zip'
    : 'ffmpeg-master-latest-linux64-gpl.zip';
const BTBN_URL = `${BTBN_BASE}/${BTBN_ASSET}`;

// Colors (skip if no TTY)
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const green = s => c('32', s);
const yellow = s => c('33', s);
const red = s => c('31', s);
const dim = s => c('2', s);

function log(msg)   { console.log(`[ffmpeg-dl] ${msg}`); }
function info(msg)  { log(green(msg)); }
function warn(msg)  { log(yellow(msg)); }
function fail(msg)  { log(red(msg)); }

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); }
  catch { return false; }
}

// Quick system-installed check via PATH lookup
function which(bin) {
  const cmd = PLATFORM === 'win32' ? `where ${bin}` : `which ${bin}`;
  const r = spawnSync(cmd, { shell: true, encoding: 'utf-8' });
  if (r.status === 0 && r.stdout.trim()) {
    const first = r.stdout.trim().split(/\r?\n/)[0];
    if (fileExists(first)) return first;
  }
  return null;
}

// Stream download to disk, following redirects, with progress.
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let downloaded = 0;
    let total = 0;
    let lastLog = 0;

    const req = https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const next = res.headers.location;
        if (!next) return reject(new Error('Redirect with no Location header'));
        log(`  -> redirect to ${next}`);
        return download(next, dest, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      total = parseInt(res.headers['content-length'] || '0', 10);

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0 && Date.now() - lastLog > 1000) {
          const pct = ((downloaded / total) * 100).toFixed(1);
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          const totalMb = (total / 1024 / 1024).toFixed(1);
          process.stdout.write(`\r[ffmpeg-dl]   ${mb}/${totalMb} MB (${pct}%)   `);
          lastLog = Date.now();
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          if (total > 0) process.stdout.write('\n');
          resolve();
        });
      });
    });

    req.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });

    file.on('error', (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Fetch a small text file via HTTPS, return trimmed contents or null.
function fetchText(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', c => body += c);
      res.on('end', () => resolve(body.trim()));
    }).on('error', () => resolve(null));
  });
}

// Extract a ZIP archive into destDir using the platform's built-in tool.
// Avoids pulling in yauzl / adm-zip as a runtime dep.
async function extractZip(zipPath, destDir) {
  if (PLATFORM === 'win32') {
    // PowerShell's Expand-Archive ships with every Windows install since Win10.
    const ps = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('PowerShell Expand-Archive failed');
  } else {
    // Use `unzip` if available (Linux/macOS); fallback to `ditto` on macOS.
    const r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' });
    if (r.status !== 0) {
      throw new Error('unzip failed. Install unzip (apt install unzip / brew install unzip) and retry.');
    }
  }
}

// Recursively find a file by name inside dir.
function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

// Convert .zip.sha256 file (one or more `<hash>  ` lines) to { file: hash }.
function parseShaFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m) out[path.basename(m[2])] = m[1].toLowerCase();
  }
  return out;
}

async function tryGyan() {
  if (PLATFORM !== 'win32') return null;   // gyan.dev is Windows-only
  info(`Trying gyan.dev Windows essentials v${GYAN_VERSION}`);
  const tmpZip = path.join(RESOURCES, '_dl-gyan.zip');
  try {
    await download(GYAN_URL, tmpZip);
  } catch (e) {
    warn(`gyan.dev download failed: ${e.message}`);
    return null;
  }

  // Verify checksum (best-effort; older builds may not have a sidecar).
  const expected = await fetchText(GYAN_SHA_URL);
  if (expected) {
    const expectedMap = parseShaFile(expected);
    const sum = (await sha256(tmpZip)).toLowerCase();
    const fileKey = `${path.basename(GYAN_URL)}.sha256`;
    const want = expectedMap[fileKey] || expectedMap[path.basename(GYAN_URL)];
    if (want && want !== sum) {
      fs.unlinkSync(tmpZip);
      warn(`gyan.dev checksum mismatch, skipping`);
      return null;
    }
    log(`  checksum ${dim('OK')}`);
  } else {
    warn(`  no checksum published; skipping verification`);
  }

  const extractDir = path.join(RESOURCES, '_dl-gyan-extract');
  ensureDir(extractDir);
  await extractZip(tmpZip, extractDir);

  const ffmpeg  = findFile(extractDir, 'ffmpeg.exe');
  const ffprobe = findFile(extractDir, 'ffprobe.exe');
  if (!ffmpeg || !ffprobe) {
    warn(`gyan.dev archive missing expected binaries`);
    return null;
  }

  // Verify the binaries are valid PE files (Windows) or ELF/Mach-O binaries (other OS).
  // (Find by name already filtered; this is belt-and-suspenders.)
  fs.copyFileSync(ffmpeg,  path.join(RESOURCES, 'ffmpeg.exe'));
  fs.copyFileSync(ffprobe, path.join(RESOURCES, 'ffprobe.exe'));

  // Cleanup temp zip + extracted staging dir.
  try { fs.unlinkSync(tmpZip); } catch {}
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  return 'gyan.dev';
}

async function tryBtbN() {
  info(`Trying BtbN/FFmpeg-Builds latest (${PLATFORM}/${ARCH})`);
  const tmpZip = path.join(RESOURCES, '_dl-btbn.zip');
  try {
    await download(BTBN_URL, tmpZip);
  } catch (e) {
    warn(`BtbN download failed: ${e.message}`);
    return null;
  }

  const extractDir = path.join(RESOURCES, '_dl-btbn-extract');
  ensureDir(extractDir);
  await extractZip(tmpZip, extractDir);

  // BtbN archives nest binaries under bin/
  const ffmpeg  = findFile(extractDir, EXE_NAME);
  const ffprobe = findFile(extractDir, PROBE_NAME);
  if (!ffmpeg || !ffprobe) {
    warn(`BtbN archive missing expected binaries`);
    return null;
  }
  fs.copyFileSync(ffmpeg,  path.join(RESOURCES, EXE_NAME));
  fs.copyFileSync(ffprobe, path.join(RESOURCES, PROBE_NAME));

  // Cleanup temp zip + extracted staging dir.
  try { fs.unlinkSync(tmpZip); } catch {}
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  return 'BtbN/FFmpeg-Builds';
}

async function main() {
  ensureDir(RESOURCES);

  const ffmpegPath  = path.join(RESOURCES, EXE_NAME);
  const ffprobePath = path.join(RESOURCES, PROBE_NAME);

  // 1. Already downloaded -> done.
  if (fileExists(ffmpegPath) && fileExists(ffprobePath)) {
    info(`Found existing ${EXE_NAME} + ${PROBE_NAME} in resources/`);
    return;
  }

  // 2. Developer can override with FFMPEG_URL.
  if (process.env.FFMPEG_URL) {
    info(`Using FFMPEG_URL override: ${process.env.FFMPEG_URL}`);
    const tmpZip = path.join(RESOURCES, '_dl-custom.zip');
    await download(process.env.FFMPEG_URL, tmpZip);
    const extractDir = path.join(RESOURCES, '_dl-custom-extract');
    ensureDir(extractDir);
    await extractZip(tmpZip, extractDir);
    const ffmpeg  = findFile(extractDir, EXE_NAME);
    const ffprobe = findFile(extractDir, PROBE_NAME);
    if (!ffmpeg || !ffprobe) throw new Error('FFMPEG_URL archive missing binaries');
    fs.copyFileSync(ffmpeg,  ffmpegPath);
    fs.copyFileSync(ffprobe, ffprobePath);
    log('  done');
    return;
  }

  // 3. System PATH check - opt-in only via FFMPEG_USE_SYSTEM=1.
  // Default behaviour is to download a known version so builds are reproducible.
  if (process.env.FFMPEG_USE_SYSTEM === '1') {
    const sysFfmpeg  = which(PLATFORM === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const sysFfprobe = which(PLATFORM === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (sysFfmpeg && sysFfprobe) {
      info(`Using system-installed binaries (FFMPEG_USE_SYSTEM=1): ${sysFfmpeg}`);
      fs.copyFileSync(sysFfmpeg,  ffmpegPath);
      fs.copyFileSync(sysFfprobe, ffprobePath);
      return;
    }
    warn(`FFMPEG_USE_SYSTEM=1 but system binaries not found on PATH; falling back to download`);
  }

  // 4. Download from a known mirror.
  const source = (await tryGyan()) || (await tryBtbN());
  if (!source) {
    fail('All download sources failed.');
    fail('Hint: install ffmpeg system-wide, or set FFMPEG_URL=https://your-mirror/your.zip');
    process.exit(1);
  }

  info(`Done (source: ${source})`);
}

main().catch(err => {
  fail(err.stack || err.message);
  process.exit(1);
});
