#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  NANOSERVE  –  single-file file server + cache server + remote tunnel
//  + NEXUS  –  magnet-link addressing layer  (nexus://<8-char-id>)
//
//  Zero npm dependencies. Node 18+ only.
//  Run:  node server.js
//
//  NEXUS QUICK REFERENCE
//  ─────────────────────
//  Every uploaded file gets a short ID (first 8 hex chars of its UUID) and
//  a self-describing magnet URI:
//
//    nexus://a3f7c821?dn=report.pdf&xl=204800&xs=<tunnel-or-local-url>
//
//  Resolve a nexus link:
//    GET /nexus/<shortId>                → 302 to the real download URL
//    GET /api/nexus/<shortId>            → JSON { fileId, nexus, resolved }
//    GET /api/nexus/<shortId>/magnet     → plain-text magnet URI
//
//  OS protocol handler (register once, then nexus:// links open in browser):
//    node server.js --install-protocol   (macOS / Linux / Windows)
//    node server.js --uninstall-protocol
// ─────────────────────────────────────────────────────────────────────────────

const http         = require('http');
const net          = require('net');
const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const os           = require('os');
const { spawn, execSync, spawnSync } = require('child_process');
const { Readable } = require('stream');

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 0 ── PROTOCOL INSTALLER  (--install-protocol / --uninstall-protocol)
// ══════════════════════════════════════════════════════════════════════════════

if (process.argv.includes('--install-protocol') || process.argv.includes('--uninstall-protocol')) {
  const installing = process.argv.includes('--install-protocol');
  installProtocol(installing);
  process.exit(0);
}

function installProtocol(install) {
  const platform = os.platform();
  const scriptPath = path.resolve(process.argv[1]);
  const nodePath   = process.execPath;

  if (platform === 'darwin') {
    // macOS: write a .app bundle that acts as the protocol handler
    const appDir  = path.join(os.homedir(), 'Applications', 'NexusHandler.app');
    const contDir = path.join(appDir, 'Contents');
    const macDir  = path.join(contDir, 'MacOS');
    const resDir  = path.join(contDir, 'Resources');

    if (!install) {
      try { fs.rmSync(appDir, { recursive: true, force: true }); } catch {}
      // Remove from Launch Services
      spawnSync('lsregister', ['-u', appDir], { stdio: 'inherit' });
      console.log('✓ nexus:// protocol handler uninstalled');
      return;
    }

    fs.mkdirSync(macDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>  <string>com.nanoserve.nexus</string>
  <key>CFBundleName</key>        <string>NexusHandler</string>
  <key>CFBundleVersion</key>     <string>1.0</string>
  <key>CFBundleExecutable</key>  <string>nexus-handler</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>    <string>Nexus Protocol</string>
      <key>CFBundleURLSchemes</key> <array><string>nexus</string></array>
    </dict>
  </array>
  <key>LSUIElement</key> <true/>
</dict>
</plist>`;
    fs.writeFileSync(path.join(contDir, 'Info.plist'), plist);

    const handlerScript = `#!/bin/bash
# Receives nexus://<shortId>?... from macOS Launch Services as $1
NEXUS_URL="$1"
SHORT_ID=$(echo "$NEXUS_URL" | sed -E 's|nexus://([^?/]+).*|\\1|')
open "http://localhost:7700/nexus/$SHORT_ID"
`;
    const handlerBin = path.join(macDir, 'nexus-handler');
    fs.writeFileSync(handlerBin, handlerScript);
    fs.chmodSync(handlerBin, 0o755);

    // Register with Launch Services
    const lsreg = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
    spawnSync(lsreg, ['-f', appDir], { stdio: 'inherit' });
    console.log('✓ nexus:// protocol handler installed →', appDir);
    console.log('  Click any nexus:// link and it will open in your browser.');

  } else if (platform === 'linux') {
    // Linux: XDG desktop entry
    const desktopDir  = path.join(os.homedir(), '.local', 'share', 'applications');
    const desktopFile = path.join(desktopDir, 'nexus-handler.desktop');

    if (!install) {
      try { fs.unlinkSync(desktopFile); } catch {}
      spawnSync('xdg-mime', ['default', ''], { stdio: 'inherit' });
      console.log('✓ nexus:// protocol handler uninstalled (you may need to run: update-desktop-database)');
      return;
    }

    fs.mkdirSync(desktopDir, { recursive: true });
    const desktop = `[Desktop Entry]
Name=Nexus Protocol Handler
Exec=${nodePath} ${scriptPath} --resolve %u
Type=Application
NoDisplay=true
MimeType=x-scheme-handler/nexus;
`;
    fs.writeFileSync(desktopFile, desktop);
    spawnSync('xdg-mime', ['default', 'nexus-handler.desktop', 'x-scheme-handler/nexus'], { stdio: 'inherit' });
    spawnSync('update-desktop-database', [desktopDir], { stdio: 'pipe' });
    console.log('✓ nexus:// protocol handler installed');

  } else if (platform === 'win32') {
    // Windows: registry entries
    if (!install) {
      try {
        execSync('reg delete HKCU\\Software\\Classes\\nexus /f', { stdio: 'pipe' });
      } catch {}
      console.log('✓ nexus:// protocol handler uninstalled from registry');
      return;
    }
    const cmd = `${nodePath} "${scriptPath}" --resolve "%1"`;
    const cmds = [
      `reg add HKCU\\Software\\Classes\\nexus /ve /d "URL:Nexus Protocol" /f`,
      `reg add HKCU\\Software\\Classes\\nexus /v "URL Protocol" /d "" /f`,
      `reg add HKCU\\Software\\Classes\\nexus\\shell\\open\\command /ve /d "${cmd}" /f`,
    ];
    for (const c of cmds) execSync(c, { stdio: 'pipe' });
    console.log('✓ nexus:// protocol handler installed in registry');
  } else {
    console.error('Unsupported platform for protocol registration:', platform);
    process.exit(1);
  }
}

// Handle --resolve <nexus://...> invoked by the OS protocol handler
if (process.argv.includes('--resolve')) {
  const nexusUrl = process.argv[process.argv.indexOf('--resolve') + 1] || '';
  const shortId  = nexusUrl.replace(/^nexus:\/\//, '').split('?')[0].trim();
  if (shortId) {
    // Open the local server resolve URL in the default browser
    const url = `http://localhost:7700/nexus/${shortId}`;
    const open = os.platform() === 'win32' ? 'start' : os.platform() === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(open, [url], { stdio: 'inherit', shell: os.platform() === 'win32' });
  }
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
//  USERS DB  (embedded JSON – edit directly to add/remove users)
// ══════════════════════════════════════════════════════════════════════════════

const USERS_DB = [
  { username: 'James', password: 'Brooksj15' },
];

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 1 ── BOOT & CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const ROOT      = path.dirname(path.resolve(process.argv[1]));
const CFG_PATH  = path.join(ROOT, 'config.json');
const HTACCESS   = path.join(ROOT, '.htaccess');
const DATA_DIR  = path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const META_DIR  = path.join(DATA_DIR, 'meta');
const LOG_PATH  = path.join(DATA_DIR, 'server.log');
const TMP_DIR   = path.join(DATA_DIR, '.tmp');

const DEFAULTS = {
  port:            7700,
  cache_port:      7701,
  auth_token:      crypto.randomBytes(24).toString('hex'),
  max_file_bytes:  1073741824,   // 1 GB
  tunnel:          true,
  tunnel_region:   'auto',
  max_cache_bytes: 134217728,   // 128 MB cache RAM cap
  max_cache_keys:  10000,        // hard key limit
};

function loadConfig() {
  let saved = {};
  if (fs.existsSync(CFG_PATH)) {
    try { saved = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
    catch { warn('config.json parse error – using defaults'); }
  }
  const cfg = Object.assign({}, DEFAULTS, saved);
  atomicWrite(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

function ensureDirs() {
  for (const d of [DATA_DIR, FILES_DIR, META_DIR, TMP_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 2 ── LOGGING
// ══════════════════════════════════════════════════════════════════════════════

const logStream = { fd: null };

function initLog() {
  logStream.fd = fs.openSync(LOG_PATH, 'a');
}

function writeLog(level, msg, extra) {
  const entry = JSON.stringify({
    t: new Date().toISOString(), level, msg, ...extra
  }) + '\n';
  if (logStream.fd !== null) fs.write(logStream.fd, entry, () => {});
  const color = level === 'ERROR' ? '\x1b[31m' : level === 'WARN' ? '\x1b[33m' : '\x1b[36m';
  console.log(`${color}[${level}]\x1b[0m ${msg}${extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`);
}

const log  = (msg, x={}) => writeLog('INFO',  msg, x);
const warn = (msg, x={}) => writeLog('WARN',  msg, x);
const err  = (msg, x={}) => writeLog('ERROR', msg, x);

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 3 ── ATOMIC I/O + METADATA STORE
// ══════════════════════════════════════════════════════════════════════════════

let tmpSeq = 0;

function atomicWrite(dest, data) {
  const tmp = path.join(TMP_DIR, `tmp_${process.pid}_${++tmpSeq}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest);
}

function metaPath(fileId) {
  return path.join(META_DIR, fileId + '.json');
}

function writeMeta(fileId, obj) {
  atomicWrite(metaPath(fileId), JSON.stringify(obj, null, 2) + '\n');
}

function readMeta(fileId) {
  const p = metaPath(fileId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function listFiles() {
  if (!fs.existsSync(META_DIR)) return [];
  return fs.readdirSync(META_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.uploaded - a.uploaded);
}

function deleteFile(fileId) {
  const meta = readMeta(fileId);
  if (!meta) return false;
  const fp = path.join(FILES_DIR, fileId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  fs.unlinkSync(metaPath(fileId));
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 3b ── .htaccess  (live-reloaded access control rules)
// ══════════════════════════════════════════════════════════════════════════════

let htRules = {
  deny:        [],
  allow:       [],
  block:       [],
  rate_limit:  0,
  cors_origin: '*',
  noindex:     false,
  auth_exempt: [],
};

const rateMap = new Map();

function cidrMatch(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr;
  const [base, bits] = cidr.split('/');
  const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0;
  const ipNum  = ip.split('.').reduce((a, b) => (a << 8) | parseInt(b, 10), 0) >>> 0;
  const baseNum = base.split('.').reduce((a, b) => (a << 8) | parseInt(b, 10), 0) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function parseHtaccess() {
  const rules = {
    deny: [], allow: [], block: [],
    rate_limit: 0, cors_origin: '*', noindex: false, auth_exempt: [],
  };
  if (!fs.existsSync(HTACCESS)) return rules;
  const lines = fs.readFileSync(HTACCESS, 'utf8').split('\n');
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd.toLowerCase()) {
      case 'deny':        rules.deny.push(arg);        break;
      case 'allow':       rules.allow.push(arg);       break;
      case 'block':       rules.block.push(arg);       break;
      case 'auth_exempt': rules.auth_exempt.push(arg); break;
      case 'rate_limit':  rules.rate_limit = parseInt(arg, 10) || 0; break;
      case 'cors_origin': rules.cors_origin = arg;     break;
      case 'noindex':     rules.noindex = true;        break;
    }
  }
  return rules;
}

function reloadHtaccess() {
  htRules = parseHtaccess();
  log('.htaccess reloaded', {
    deny: htRules.deny.length, allow: htRules.allow.length,
    block: htRules.block.length, rate_limit: htRules.rate_limit,
  });
}

function watchHtaccess() {
  if (!fs.existsSync(HTACCESS)) {
    fs.writeFileSync(HTACCESS, [
      '# NanoServe .htaccess',
      '# Uncomment and edit rules as needed.',
      '',
      '# deny  192.168.1.100',
      '# allow 192.168.1.0/24',
      '# block /secret',
      '# rate_limit 60',
      '# cors_origin https://example.com',
      '# noindex',
      '# auth_exempt /files',
      '# auth_exempt /nexus',
      '',
    ].join('\n'));
  }
  reloadHtaccess();
  try {
    fs.watch(HTACCESS, { persistent: false }, () => {
      setTimeout(reloadHtaccess, 50);
    });
  } catch (e) {
    warn('Cannot watch .htaccess', { msg: e.message });
  }
}

function htaccessCheck(req) {
  const ip       = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const pathname = new URL(req.url, 'http://x').pathname;

  for (const rule of htRules.deny) {
    if (cidrMatch(ip, rule)) return { status: 403, error: 'Forbidden' };
  }
  if (htRules.allow.length > 0) {
    const permitted = htRules.allow.some(rule => cidrMatch(ip, rule));
    if (!permitted) return { status: 403, error: 'Forbidden' };
  }
  for (const prefix of htRules.block) {
    if (pathname.startsWith(prefix)) return { status: 403, error: 'Forbidden' };
  }
  if (htRules.rate_limit > 0) {
    const now   = Date.now();
    let   entry = rateMap.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + 60_000 };
      rateMap.set(ip, entry);
    }
    entry.count++;
    if (entry.count > htRules.rate_limit) return { status: 429, error: 'Too Many Requests' };
  }
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateMap) if (now > v.resetAt) rateMap.delete(k);
}, 120_000).unref();

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 3c ── NEXUS  –  magnet-link addressing layer
// ══════════════════════════════════════════════════════════════════════════════
//
//  Short ID:  first 8 hex characters of the 32-char fileId UUID
//             e.g.  fileId = "a3f7c821d4e5f60b..." → shortId = "a3f7c821"
//
//  Magnet URI format (inspired by BitTorrent BEP-09):
//    nexus://<shortId>?dn=<filename>&xl=<bytes>&xs=<download-url>
//
//  xs (exact source) prefers the Cloudflare tunnel URL when available so
//  that the link works from outside the local network.
//
//  Collision handling:
//    - 8 hex chars = 2^32 ≈ 4 billion possibilities.
//    - For a personal server with <1 000 files, collision probability is
//      negligible (~0.00002%).
//    - resolveNexus() returns the FIRST match and logs a warning if two
//      files share a short ID (astronomically unlikely but handled).
// ──────────────────────────────────────────────────────────────────────────────

function shortId(fileId) {
  return fileId.slice(0, 8);
}

function buildNexusMagnet(meta, baseUrl) {
  const sid = shortId(meta.fileId);
  const xs  = `${baseUrl}/files/${meta.fileId}`;
  const params = new URLSearchParams({
    dn: meta.name,
    xl: String(meta.size),
    xs,
  });
  return `nexus://${sid}?${params.toString()}`;
}

// Return { meta, nexus, resolvedUrl } or null
function resolveNexus(sid, cfg) {
  if (!/^[a-f0-9]{8}$/.test(sid)) return null;
  const all     = listFiles();
  const matches = all.filter(m => m.fileId.startsWith(sid));
  if (matches.length === 0) return null;
  if (matches.length > 1) warn('Nexus short-ID collision', { sid, count: matches.length });

  const meta       = matches[0];
  const base       = tunnelUrl || `http://localhost:${cfg.port}`;
  const nexus      = buildNexusMagnet(meta, base);
  const resolvedUrl = `${base}/files/${meta.fileId}`;
  return { meta, nexus, resolvedUrl };
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 4 ── IN-MEMORY CACHE  (Redis-style, also exposed as TCP server)
// ══════════════════════════════════════════════════════════════════════════════

const cacheStore = new Map();
let cacheBytesUsed = 0;

const cache = {
  set(key, value, ttlMs = 0, cfg = null) {
    const str   = String(value);
    const bytes = Buffer.byteLength(str, 'utf8');
    const exp   = ttlMs > 0 ? Date.now() + ttlMs : null;
    const maxB  = cfg ? cfg.max_cache_bytes : 134217728;
    const maxK  = cfg ? cfg.max_cache_keys  : 10000;
    const existing = cacheStore.get(key);
    if (existing) cacheBytesUsed -= existing.bytes;
    while ((cacheBytesUsed + bytes > maxB || cacheStore.size >= maxK) && cacheStore.size > 0) {
      const oldestKey = cacheStore.keys().next().value;
      const oldest    = cacheStore.get(oldestKey);
      cacheBytesUsed -= oldest.bytes;
      cacheStore.delete(oldestKey);
    }
    cacheStore.set(key, { value: str, exp, bytes });
    cacheBytesUsed += bytes;
  },
  get(key) {
    const entry = cacheStore.get(key);
    if (!entry) return null;
    if (entry.exp !== null && Date.now() > entry.exp) {
      cacheBytesUsed -= entry.bytes;
      cacheStore.delete(key);
      return null;
    }
    return entry.value;
  },
  del(key) {
    const e = cacheStore.get(key);
    if (!e) return 0;
    cacheBytesUsed -= e.bytes;
    cacheStore.delete(key);
    return 1;
  },
  ttl(key) {
    const entry = cacheStore.get(key);
    if (!entry) return -2;
    if (entry.exp === null) return -1;
    const rem = entry.exp - Date.now();
    return rem > 0 ? rem : -2;
  },
  keys(pattern = '*') {
    const re  = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const now = Date.now();
    const results = [];
    for (const [k, v] of cacheStore) {
      if (v.exp !== null && now > v.exp) { cacheStore.delete(k); continue; }
      if (re.test(k)) results.push(k);
    }
    return results;
  },
  flush() { cacheStore.clear(); cacheBytesUsed = 0; },
  size()  { return cacheStore.size; },
  bytes() { return cacheBytesUsed; },
};

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cacheStore) {
    if (v.exp !== null && now > v.exp) { cacheBytesUsed -= v.bytes; cacheStore.delete(k); }
  }
}, 30_000).unref();

function handleCacheCommand(line) {
  const parts = line.trimEnd().split(' ');
  const cmd   = (parts[0] || '').toUpperCase();
  if (cmd === 'PING')  return '+PONG';
  if (cmd === 'FLUSH') { cache.flush(); return '+OK'; }
  if (cmd === 'SET') {
    const [, key, ttl, ...rest] = parts;
    if (!key) return '-ERR missing key';
    cache.set(key, rest.join(' '), parseInt(ttl, 10) || 0);
    return '+OK';
  }
  if (cmd === 'GET')  { const v = cache.get(parts[1]); return v === null ? '-nil' : '$' + v; }
  if (cmd === 'DEL')  return ':' + cache.del(parts[1]);
  if (cmd === 'TTL')  return ':' + cache.ttl(parts[1]);
  if (cmd === 'KEYS') {
    const ks = cache.keys(parts[1] || '*');
    return ks.map(k => '*' + k).join('\n') + (ks.length ? '\n' : '') + '*done';
  }
  return '-ERR unknown command';
}

function startCacheServer(port) {
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          try { socket.write(handleCacheCommand(line) + '\n'); }
          catch (e) { socket.write('-ERR internal\n'); }
        }
      }
    });
    socket.on('error', () => {});
  });
  server.on('error', e => err('Cache server error', { msg: e.message }));
  server.listen(port, '127.0.0.1', () => log(`Cache server listening`, { port, host: '127.0.0.1' }));
  return server;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 5 ── MULTIPART UPLOAD PARSER  (zero deps, streaming)
// ══════════════════════════════════════════════════════════════════════════════

function parseContentType(header) {
  const m = (header || '').match(/boundary=("?)([^";]+)\1/i);
  return m ? m[2] : null;
}

function parseMultipart(req, boundary, destDir, maxBytes) {
  return new Promise((resolve, reject) => {
    const SEP   = Buffer.from('\r\n--' + boundary);
    const CRLF2 = Buffer.from('\r\n\r\n');
    let buf      = Buffer.from('\r\n');
    let received = 0;
    const files  = [];
    let currentStream = null;
    let currentMeta   = null;
    let currentSize   = 0;

    function closeCurrentPart() {
      if (!currentStream) return;
      currentStream.end();
      if (currentMeta && currentSize > 0) {
        files.push({ ...currentMeta, size: currentSize });
      } else if (currentMeta) {
        try { fs.unlinkSync(path.join(destDir, currentMeta.fileId)); } catch {}
      }
      currentStream = null; currentMeta = null; currentSize = 0;
    }

    function openPart(headerBlock) {
      const nameMatch = headerBlock.match(/name="([^"]+)"/i);
      const fileMatch = headerBlock.match(/filename="([^"]+)"/i);
      if (!nameMatch || !fileMatch) return false;
      const origName = path.basename(fileMatch[1].trim()) || 'upload';
      const ctMatch  = headerBlock.match(/Content-Type:\s*([^\r\n]+)/i);
      const mime     = ctMatch ? ctMatch[1].trim() : guessMime(origName);
      const fileId   = crypto.randomBytes(16).toString('hex');
      const destPath = path.join(destDir, fileId);
      currentMeta   = { fileId, origName, mime };
      currentSize   = 0;
      currentStream = fs.createWriteStream(destPath);
      currentStream.on('error', e => reject(new Error('Write error: ' + e.message)));
      return true;
    }

    function processBuffer() {
      while (true) {
        const sepIdx = buf.indexOf(SEP);
        if (sepIdx === -1) {
          if (currentStream && buf.length > SEP.length) {
            const safe = buf.slice(0, buf.length - (SEP.length - 1));
            currentStream.write(safe);
            currentSize += safe.length;
            buf = buf.slice(safe.length);
          }
          break;
        }
        if (currentStream && sepIdx > 0) {
          currentStream.write(buf.slice(0, sepIdx));
          currentSize += sepIdx;
        }
        closeCurrentPart();
        buf = buf.slice(sepIdx + SEP.length);
        if (buf.length >= 2 && buf[0] === 0x2D && buf[1] === 0x2D) break;
        if (buf.length >= 2 && buf[0] === 0x0D && buf[1] === 0x0A) buf = buf.slice(2);
        const h2Idx = buf.indexOf(CRLF2);
        if (h2Idx === -1) break;
        const headerBlock = buf.slice(0, h2Idx).toString('utf8');
        buf = buf.slice(h2Idx + 4);
        openPart(headerBlock);
      }
    }

    req.on('data', chunk => {
      received += chunk.length;
      if (received > maxBytes) { closeCurrentPart(); req.destroy(); return reject(new Error('Upload too large')); }
      buf = Buffer.concat([buf, chunk]);
      processBuffer();
    });
    req.on('end', () => { processBuffer(); closeCurrentPart(); resolve(files); });
    req.on('error', e => { closeCurrentPart(); reject(e); });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 6 ── CLOUDFLARE TUNNEL
// ══════════════════════════════════════════════════════════════════════════════

let tunnelUrl = null;

async function startTunnel(localPort) {
  const platform = os.platform();
  const arch     = os.arch();
  const binaryMap = {
    'linux-x64':    'cloudflared-linux-amd64',
    'linux-arm64':  'cloudflared-linux-arm64',
    'linux-arm':    'cloudflared-linux-arm',
    'darwin-x64':   'cloudflared-darwin-amd64',
    'darwin-arm64': 'cloudflared-darwin-arm64',
    'win32-x64':    'cloudflared-windows-amd64.exe',
  };
  const key    = `${platform}-${arch === 'x64' ? 'x64' : arch}`;
  const binary = binaryMap[key];
  if (!binary) { warn('cloudflared: unsupported platform', { platform, arch }); return; }

  const ext     = platform === 'win32' ? '.exe' : '';
  const cfPath  = path.join(DATA_DIR, 'cloudflared' + ext);
  const version = '2024.5.0';
  const dlUrl   = `https://github.com/cloudflare/cloudflared/releases/download/${version}/${binary}`;

  if (!fs.existsSync(cfPath)) {
    log('Downloading cloudflared…', { url: dlUrl });
    try {
      const res = await fetch(dlUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      atomicWrite(cfPath, Buffer.from(buf));
      if (platform !== 'win32') fs.chmodSync(cfPath, 0o755);
      log('cloudflared downloaded');
    } catch (e) {
      warn('Could not download cloudflared – remote access disabled', { error: e.message });
      return;
    }
  }

  const args  = ['tunnel', '--url', `http://localhost:${localPort}`];
  const child = spawn(cfPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let resolved = false;

  function scanOutput(data) {
    const text = data.toString();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !resolved) {
      resolved  = true;
      tunnelUrl = m[0];
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      log(`  Remote URL: ${tunnelUrl}`);
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      cache.set('__tunnel_url__', tunnelUrl);
    }
  }
  child.stdout.on('data', scanOutput);
  child.stderr.on('data', scanOutput);
  child.on('exit', code => { if (code !== 0 && code !== null) warn('cloudflared exited', { code }); tunnelUrl = null; });
  setTimeout(() => { if (!resolved) warn('cloudflared did not produce a URL within 30s'); }, 30_000);
  return child;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 7 ── AUTH MIDDLEWARE  (username / password sessions)
// ══════════════════════════════════════════════════════════════════════════════

// In-memory session store: sessionId → username
const sessions = new Map();

function createSession(username) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, username);
  return sid;
}

function checkAuth(req) {
  const cookie = parseCookie(req.headers['cookie'] || '')['sid'];
  return cookie && sessions.has(cookie);
}

function parseCookie(str) {
  return Object.fromEntries(str.split(';').map(p => {
    const [k, ...v] = p.trim().split('=');
    return [k, v.join('=')];
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 8 ── MIME TYPES
// ══════════════════════════════════════════════════════════════════════════════

const MIME = {
  '.html': 'text/html', '.htm': 'text/html',
  '.js':   'application/javascript', '.mjs': 'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif', '.webp': 'image/webp', '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.pdf':  'application/pdf',
  '.zip':  'application/zip', '.gz': 'application/gzip',
  '.mp4':  'video/mp4', '.webm': 'video/webm',
  '.mp3':  'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.txt':  'text/plain', '.md': 'text/plain',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function guessMime(filename) {
  return MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 9 ── HTTP ROUTER
// ══════════════════════════════════════════════════════════════════════════════

function respond(res, status, body, headers = {}) {
  const isJson  = typeof body === 'object' && body !== null;
  const payload = isJson ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'Content-Type':   isJson ? 'application/json' : 'text/plain',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function respondHtml(res, html) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

async function handleRequest(req, res, cfg) {
  const urlObj   = new URL(req.url, 'http://x');
  const pathname = urlObj.pathname;
  const method   = req.method.toUpperCase();

  const htBlock = htaccessCheck(req);
  if (htBlock) return respond(res, htBlock.status, { error: htBlock.error });

  res.setHeader('Access-Control-Allow-Origin', htRules.cors_origin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (htRules.noindex) res.setHeader('X-Robots-Tag', 'noindex,nofollow');
  if (method === 'OPTIONS') return respond(res, 204, '');

  // Login
  if (pathname === '/login') {
    if (method === 'GET')  return respondHtml(res, renderLogin(cfg));
    if (method === 'POST') return handleLogin(req, res, cfg);
  }

  const isExempt = htRules.auth_exempt.some(p => pathname.startsWith(p));
  if (!isExempt && !checkAuth(req)) {
    const wants_html = (req.headers['accept'] || '').includes('text/html');
    if (wants_html) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return respond(res, 401, { error: 'Unauthorized' });
  }

  // ── Root UI ─────────────────────────────────────────────────────────────
  if (pathname === '/' && method === 'GET') return respondHtml(res, renderUI(cfg));

  // ══════════════════════════════════════════════════════════════════════════
  //  NEXUS ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // Browser redirect:  GET /nexus/<shortId>  → 302 to download URL
  // This is what the OS protocol handler opens in the browser.
  const nexusRedirect = pathname.match(/^\/nexus\/([a-f0-9]{8})$/);
  if (nexusRedirect && method === 'GET') {
    const result = resolveNexus(nexusRedirect[1], cfg);
    if (!result) return respond(res, 404, { error: 'Nexus ID not found' });
    log('nexus redirect', { sid: nexusRedirect[1], file: result.meta.name });
    res.writeHead(302, { Location: result.resolvedUrl });
    return res.end();
  }

  // JSON info:  GET /api/nexus/<shortId>
  const nexusInfo = pathname.match(/^\/api\/nexus\/([a-f0-9]{8})$/);
  if (nexusInfo && method === 'GET') {
    const result = resolveNexus(nexusInfo[1], cfg);
    if (!result) return respond(res, 404, { error: 'Nexus ID not found' });
    return respond(res, 200, {
      shortId:     nexusInfo[1],
      fileId:      result.meta.fileId,
      name:        result.meta.name,
      size:        result.meta.size,
      mime:        result.meta.mime,
      uploaded:    result.meta.uploaded,
      nexus:       result.nexus,
      resolvedUrl: result.resolvedUrl,
    });
  }

  // Raw magnet URI:  GET /api/nexus/<shortId>/magnet
  const nexusMagnet = pathname.match(/^\/api\/nexus\/([a-f0-9]{8})\/magnet$/);
  if (nexusMagnet && method === 'GET') {
    const result = resolveNexus(nexusMagnet[1], cfg);
    if (!result) return respond(res, 404, { error: 'Nexus ID not found' });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(result.nexus);
  }

  // List all nexus links:  GET /api/nexus
  if (pathname === '/api/nexus' && method === 'GET') {
    const base  = tunnelUrl || `http://localhost:${cfg.port}`;
    const files = listFiles().map(meta => ({
      shortId: shortId(meta.fileId),
      fileId:  meta.fileId,
      name:    meta.name,
      size:    meta.size,
      nexus:   buildNexusMagnet(meta, base),
    }));
    return respond(res, 200, { files });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ORIGINAL ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // List files
  if (pathname === '/api/files' && method === 'GET') {
    const base  = tunnelUrl || `http://localhost:${cfg.port}`;
    const files = listFiles().map(meta => ({
      ...meta,
      shortId: shortId(meta.fileId),
      nexus:   buildNexusMagnet(meta, base),
    }));
    return respond(res, 200, { files, tunnel: tunnelUrl });
  }

  // Upload
  if (pathname === '/api/upload' && method === 'POST') {
    const ct       = req.headers['content-type'] || '';
    const boundary = parseContentType(ct);
    if (!boundary) return respond(res, 400, { error: 'Expected multipart/form-data' });
    try {
      const uploaded = await parseMultipart(req, boundary, FILES_DIR, cfg.max_file_bytes);
      const base     = tunnelUrl || `http://localhost:${cfg.port}`;
      const saved    = [];
      for (const f of uploaded) {
        const meta = {
          fileId:   f.fileId,
          name:     f.origName,
          mime:     f.mime || guessMime(f.origName),
          size:     f.size,
          uploaded: Date.now(),
          shortId:  shortId(f.fileId),
          nexus:    buildNexusMagnet({ fileId: f.fileId, name: f.origName, size: f.size }, base),
        };
        writeMeta(f.fileId, meta);
        log('upload', { name: f.origName, size: f.size, id: f.fileId, shortId: meta.shortId, nexus: meta.nexus });
        saved.push(meta);
      }
      return respond(res, 200, { uploaded: saved });
    } catch (e) {
      err('Upload failed', { msg: e.message });
      return respond(res, 500, { error: e.message });
    }
  }

  // Download by full fileId
  const dlMatch = pathname.match(/^\/files\/([a-f0-9]{32})$/);
  if (dlMatch && method === 'GET') {
    const fileId = dlMatch[1];
    const meta   = readMeta(fileId);
    if (!meta) return respond(res, 404, { error: 'Not found' });
    const fp   = path.join(FILES_DIR, fileId);
    const stat = fs.statSync(fp, { throwIfNoEntry: false });
    if (!stat) return respond(res, 404, { error: 'File missing on disk' });
    const disposition = `attachment; filename="${encodeURIComponent(meta.name)}"`;
    res.writeHead(200, {
      'Content-Type':        meta.mime,
      'Content-Length':      stat.size,
      'Content-Disposition': disposition,
      'Cache-Control':       'private, max-age=3600',
    });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  // Delete
  const delMatch = pathname.match(/^\/api\/files\/([a-f0-9]{32})$/);
  if (delMatch && method === 'DELETE') {
    const ok = deleteFile(delMatch[1]);
    return respond(res, ok ? 200 : 404, { ok });
  }

  // Cache API
  if (pathname.startsWith('/api/cache')) {
    return handleCacheHttp(req, res, pathname, method, urlObj, cfg);
  }

  // Server info
  if (pathname === '/api/info' && method === 'GET') {
    return respond(res, 200, {
      version:     '2.0.0',
      uptime:      process.uptime(),
      files:       listFiles().length,
      cache_keys:  cache.size(),
      cache_bytes: cache.bytes(),
      cache_limit: cfg.max_cache_bytes,
      tunnel:      tunnelUrl,
      memory:      process.memoryUsage(),
      node:        process.version,
      nexus:       'enabled',
    });
  }

  // Logs
  if (pathname === '/api/logs' && method === 'GET') {
    const n     = Math.min(parseInt(urlObj.searchParams.get('n') || '100'), 500);
    const lines = tailLog(n);
    return respond(res, 200, { lines });
  }

  return respond(res, 404, { error: 'Not found' });
}

// ── Cache HTTP handlers ────────────────────────────────────────────────────

async function handleCacheHttp(req, res, pathname, method, urlObj, cfg) {
  const keyMatch = pathname.match(/^\/api\/cache\/(.+)$/);
  if (!keyMatch) {
    if (method === 'GET') {
      const pat = urlObj.searchParams.get('pattern') || '*';
      return respond(res, 200, { keys: cache.keys(pat), size: cache.size() });
    }
    if (method === 'DELETE') { cache.flush(); return respond(res, 200, { ok: true }); }
    return respond(res, 400, { error: 'Specify a key' });
  }
  const key = decodeURIComponent(keyMatch[1]);
  if (method === 'GET') {
    const val = cache.get(key);
    if (val === null) return respond(res, 404, { error: 'Key not found' });
    return respond(res, 200, { key, value: val, ttl: cache.ttl(key) });
  }
  if (method === 'PUT' || method === 'POST') {
    const body = await readBody(req, 1_048_576);
    let parsed;
    try { parsed = JSON.parse(body); } catch { return respond(res, 400, { error: 'Invalid JSON' }); }
    cache.set(key, parsed.value ?? '', parsed.ttl ?? 0, cfg);
    return respond(res, 200, { ok: true });
  }
  if (method === 'DELETE') { const n = cache.del(key); return respond(res, 200, { deleted: n }); }
  return respond(res, 405, { error: 'Method not allowed' });
}

// ── Login handler ──────────────────────────────────────────────────────────

async function handleLogin(req, res, cfg) {
  const body = await readBody(req, 4096);
  let username = '', password = '';
  try {
    const p = new URLSearchParams(body);
    username = p.get('username') || '';
    password = p.get('password') || '';
  } catch {}
  const user = USERS_DB.find(u => u.username === username && u.password === password);
  if (user) {
    const sid = createSession(user.username);
    res.writeHead(302, {
      'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
      'Location':   '/',
    });
    return res.end();
  }
  respondHtml(res, renderLogin(cfg, true));
}

// ── Body reader ────────────────────────────────────────────────────────────

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = ''; let size = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { req.destroy(); return reject(new Error('Body too large')); }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ── Log tail ───────────────────────────────────────────────────────────────

function tailLog(n) {
  if (!fs.existsSync(LOG_PATH)) return [];
  const content = fs.readFileSync(LOG_PATH, 'utf8');
  const lines   = content.trim().split('\n').filter(Boolean);
  return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 10 ── UI  (login + main)
// ══════════════════════════════════════════════════════════════════════════════

function renderLogin(cfg, failed = false) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>NanoServe – Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:2rem;width:340px}
  h1{font-size:1.25rem;margin-bottom:1.5rem;color:#a78bfa}
  input{width:100%;padding:.6rem .8rem;background:#12141f;border:1px solid #2d3148;border-radius:6px;color:#e2e8f0;font-size:.95rem;margin-bottom:1rem}
  button{width:100%;padding:.7rem;background:#7c3aed;border:none;border-radius:6px;color:#fff;font-size:.95rem;cursor:pointer}
  button:hover{background:#6d28d9}
  .err{color:#f87171;font-size:.85rem;margin-bottom:.75rem}
</style></head><body>
<div class="card">
  <h1>⬡ NanoServe</h1>
  ${failed ? '<p class="err">Invalid credentials — try again.</p>' : ''}
  <form method="POST" action="/login">
    <input type="text" name="username" placeholder="Username" autofocus autocomplete="username">
    <input type="password" name="password" placeholder="Password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

function renderUI(cfg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>NanoServe + Nexus</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
  header{background:#1a1d2e;border-bottom:1px solid #2d3148;padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem}
  header h1{font-size:1.1rem;color:#a78bfa;flex:1}
  .tunnel-badge{font-size:.75rem;padding:.25rem .6rem;border-radius:20px;background:#1e2130;border:1px solid #2d3148}
  .tunnel-badge.live{border-color:#34d399;color:#34d399}
  .tunnel-badge.waiting{border-color:#fbbf24;color:#fbbf24}
  main{max-width:900px;margin:0 auto;padding:1.5rem}
  .drop{border:2px dashed #2d3148;border-radius:12px;padding:2.5rem;text-align:center;cursor:pointer;transition:.2s;margin-bottom:1.5rem}
  .drop:hover,.drop.over{border-color:#7c3aed;background:#1a1030}
  .drop p{color:#64748b;font-size:.9rem;margin-top:.4rem}
  input[type=file]{display:none}
  .progress-wrap{display:none;margin-bottom:1rem}
  .progress-bar-bg{background:#1e2130;border-radius:6px;height:8px;overflow:hidden}
  .progress-bar{background:#7c3aed;height:100%;width:0;transition:width .2s}
  .progress-label{font-size:.78rem;color:#64748b;margin-top:.3rem}
  table{width:100%;border-collapse:collapse;font-size:.875rem}
  th{text-align:left;padding:.5rem .75rem;color:#64748b;font-weight:500;border-bottom:1px solid #1e2130}
  td{padding:.6rem .75rem;border-bottom:1px solid #1a1d2e;vertical-align:middle}
  tr:hover td{background:#13151f}
  .nexus-chip{font-family:monospace;font-size:.78rem;background:#1a0f2e;border:1px solid #4c1d95;color:#a78bfa;padding:.15rem .45rem;border-radius:4px;cursor:pointer;user-select:all;white-space:nowrap}
  .nexus-chip:hover{background:#2d1060}
  .btn{padding:.3rem .65rem;border:none;border-radius:5px;cursor:pointer;font-size:.8rem}
  .btn-dl{background:#1e3a5f;color:#93c5fd}.btn-dl:hover{background:#1e40af}
  .btn-nx{background:#1a0f2e;color:#a78bfa;border:1px solid #4c1d95}.btn-nx:hover{background:#2d1060}
  .btn-cp{background:#14302a;color:#6ee7b7;border:1px solid #065f46}.btn-cp:hover{background:#065f46}
  .btn-del{background:#2d1010;color:#fca5a5;border:1px solid #7f1d1d}.btn-del:hover{background:#7f1d1d}
  .sz{color:#64748b;font-size:.78rem}
  .info-grid{display:none;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:.75rem;margin-bottom:1.5rem}
  .info-card{background:#1e2130;border:1px solid #2d3148;border-radius:8px;padding:.75rem}
  .info-card .label{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em}
  .info-card .value{font-size:1rem;font-weight:600;margin-top:.15rem}
  .section-header{display:flex;align-items:center;justify-content:space-between;margin:1.25rem 0 .75rem}
  .section-header h2{font-size:.95rem;color:#94a3b8}
  .toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#1e2130;border:1px solid #2d3148;border-radius:8px;padding:.6rem 1rem;font-size:.85rem;opacity:0;transition:.3s;pointer-events:none;z-index:999}
  .toast.show{opacity:1}
  .toast.err{border-color:#7f1d1d;color:#fca5a5}
  .nexus-panel{background:#12091e;border:1px solid #4c1d95;border-radius:8px;padding:1rem;margin-bottom:1.5rem}
  .nexus-panel h3{font-size:.85rem;color:#a78bfa;margin-bottom:.5rem}
  .nexus-panel code{font-size:.78rem;color:#c4b5fd;display:block;word-break:break-all;margin-bottom:.5rem}
  .nexus-panel small{color:#64748b;font-size:.73rem}
</style>
</head><body>
<header>
  <h1>⬡ NanoServe <span style="color:#4c1d95;font-size:.8rem">+ Nexus</span></h1>
  <span id="tunnel-badge" class="tunnel-badge waiting">⏳ tunnel connecting…</span>
  <button class="btn btn-nx" onclick="loadInfo()">ℹ Info</button>
</header>
<main>

  <!-- Nexus explainer -->
  <div class="nexus-panel">
    <h3>⬡ Nexus Protocol</h3>
    <code id="nexus-example">nexus://????????  — upload a file to see your first magnet link</code>
    <small>Each file gets a short 8-char ID. Click any nexus:// chip to copy. 
    Install OS handler: <code style="display:inline;background:none;color:#7c3aed">node server.js --install-protocol</code></small>
  </div>

  <!-- Info grid -->
  <div id="info-grid" class="info-grid"></div>

  <!-- Drop zone -->
  <label for="file-input">
    <div id="drop" class="drop">
      <div style="font-size:2rem">⬡</div>
      <strong>Drop files here or click to upload</strong>
      <p>Max 1 GB per file · Ctrl+V to paste</p>
    </div>
  </label>
  <input type="file" id="file-input" multiple>

  <!-- Progress -->
  <div class="progress-wrap" id="progress-wrap">
    <div class="progress-bar-bg"><div class="progress-bar" id="progress-bar"></div></div>
    <div class="progress-label" id="progress-label"></div>
  </div>

  <!-- File list -->
  <div class="section-header">
    <h2>Files</h2>
    <button class="btn btn-nx" onclick="loadFiles()">↻ Refresh</button>
  </div>
  <table>
    <thead><tr>
      <th>Name</th>
      <th>Nexus ID</th>
      <th>Size</th>
      <th>Uploaded</th>
      <th style="text-align:right">Actions</th>
    </tr></thead>
    <tbody id="file-list"><tr><td colspan="5" style="color:#64748b;padding:1rem">Loading…</td></tr></tbody>
  </table>
</main>

<div id="toast" class="toast"></div>

<script>
const $ = id => document.getElementById(id);

function toast(msg, type='') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (type === 'err' ? ' err' : '');
  setTimeout(() => t.className = 'toast', 2800);
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString();
}

async function loadFiles() {
  const r    = await fetch('/api/files');
  const data = await r.json();

  // Update tunnel badge
  const badge = $('tunnel-badge');
  if (data.tunnel) {
    badge.textContent = '⬡ ' + data.tunnel.replace('https://', '');
    badge.className   = 'tunnel-badge live';
    window.__tunnel   = data.tunnel;
  } else {
    badge.textContent = '⏳ tunnel connecting…';
    badge.className   = 'tunnel-badge waiting';
  }

  // Update nexus example
  if (data.files && data.files.length > 0) {
    $('nexus-example').textContent = data.files[0].nexus;
  }

  const tbody = $('file-list');
  if (!data.files || data.files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:#64748b;padding:1rem">No files yet — drop something above!</td></tr>';
    return;
  }

  tbody.innerHTML = data.files.map(f => \`
    <tr>
      <td><a href="/files/\${f.fileId}"
             style="color:#e2e8f0;text-decoration:none" title="\${f.fileId}">\${esc(f.name)}</a></td>
      <td>
        <span class="nexus-chip" onclick="copyNexus('\${esc(f.nexus)}')" title="\${esc(f.nexus)}">
          nexus://\${f.shortId}
        </span>
      </td>
      <td class="sz">\${fmtBytes(f.size)}</td>
      <td class="sz">\${fmtDate(f.uploaded)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-dl" onclick="dlFile('\${f.fileId}')">↓</button>
        <button class="btn btn-cp" onclick="copyLink('\${f.fileId}')">🔗</button>
        <button class="btn btn-nx" onclick="copyNexus('\${esc(f.nexus)}')">⬡</button>
        <button class="btn btn-del" onclick="delFile('\${f.fileId}')">✕</button>
      </td>
    </tr>
  \`).join('');

  return data;
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function dlFile(id) {
  window.location = '/files/' + id;
}

function copyLink(id) {
  const base = window.__tunnel || location.origin;
  const url  = base + '/files/' + id;
  navigator.clipboard.writeText(url).then(() => toast('HTTP link copied!'));
}

function copyNexus(nexus) {
  navigator.clipboard.writeText(nexus).then(() => toast('Nexus link copied! ⬡'));
}

// ── Upload ─────────────────────────────────────────────────────────────────
async function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('file', f);

  $('progress-wrap').style.display = 'block';
  $('progress-bar').style.width    = '5%';
  $('progress-label').textContent  = 'Uploading ' + files.length + ' file(s)…';

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        $('progress-bar').style.width    = pct + '%';
        $('progress-label').textContent  = pct + '% — ' + fmtBytes(e.loaded) + ' / ' + fmtBytes(e.total);
      }
    };
    xhr.onload = () => {
      $('progress-bar').style.width = '100%';
      setTimeout(() => { $('progress-wrap').style.display = 'none'; $('progress-bar').style.width = '0'; }, 1000);
      const res = JSON.parse(xhr.responseText);
      if (xhr.status === 200) {
        const first = res.uploaded[0];
        toast('✓ ' + res.uploaded.length + ' file(s) uploaded — ' + first.nexus);
        loadFiles();
      } else toast('Upload error: ' + (res.error || xhr.status), 'err');
    };
    xhr.onerror = () => toast('Network error during upload', 'err');
    xhr.send(fd);
  } catch (e) { toast(e.message, 'err'); }
}

// ── Drag & drop ────────────────────────────────────────────────────────────
const drop = $('drop');
drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', e => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('over');
  uploadFiles([...e.dataTransfer.files]);
});
$('file-input').addEventListener('change', e => uploadFiles([...e.target.files]));

// ── Paste upload ───────────────────────────────────────────────────────────
document.addEventListener('paste', e => {
  const items = [...(e.clipboardData?.items || [])];
  const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); uploadFiles(files); }
});

// ── Info panel ─────────────────────────────────────────────────────────────
async function loadInfo() {
  const r    = await fetch('/api/info');
  const info = await r.json();
  const grid = $('info-grid');
  grid.style.display = grid.style.display === 'grid' ? 'none' : 'grid';
  grid.innerHTML = [
    ['Files',   info.files],
    ['Cache',   info.cache_keys + ' keys'],
    ['Uptime',  Math.floor(info.uptime) + 's'],
    ['Heap',    fmtBytes(info.memory.heapUsed)],
    ['Node',    info.node],
    ['Tunnel',  info.tunnel ? '✓ live' : '⏳'],
    ['Nexus',   '✓ ' + info.nexus],
  ].map(([l,v]) => \`<div class="info-card"><div class="label">\${l}</div><div class="value">\${v}</div></div>\`).join('');
}

// ── Init ───────────────────────────────────────────────────────────────────
loadFiles();
(function pollTunnel() {
  const badge = $('tunnel-badge');
  if (badge.classList.contains('waiting')) setTimeout(() => { loadFiles().then(pollTunnel); }, 4000);
})();
</script>
</body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 11 ── GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════════════

function setupShutdown(servers) {
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutdown (${signal})`);
    const close = s => new Promise(r => s.close(r));
    await Promise.allSettled(servers.map(close));
    if (logStream.fd !== null) fs.closeSync(logStream.fd);
    process.exit(0);
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException',  e => err('Uncaught exception', { msg: e.message, stack: e.stack }));
  process.on('unhandledRejection', reason => err('Unhandled rejection', { msg: String(reason) }));
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 12 ── MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  ensureDirs();
  initLog();
  const cfg = loadConfig();
  watchHtaccess();

  log('═══════════════════════════════════════════════');
  log(' NanoServe + Nexus starting up');
  log('═══════════════════════════════════════════════');
  log(`Config loaded`, { port: cfg.port, cache_port: cfg.cache_port });
  log('Nexus protocol: nexus://<8-char-id>');
  log('Install OS handler: node server.js --install-protocol');

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, cfg).catch(e => {
      err('Request error', { url: req.url, msg: e.message });
      try { respond(res, 500, { error: 'Internal server error' }); } catch {}
    });
  });

  httpServer.listen(cfg.port, '0.0.0.0', () => {
    log(`HTTP server ready`, { url: `http://localhost:${cfg.port}` });
    log(`Open: http://localhost:${cfg.port}/login`);
  });

  const cacheServer = startCacheServer(cfg.cache_port);

  if (cfg.tunnel) {
    log('Starting Cloudflare tunnel…');
    startTunnel(cfg.port).catch(e => warn('Tunnel error', { msg: e.message }));
  } else {
    log('Tunnel disabled in config');
  }

  setupShutdown([httpServer, cacheServer]);
}

main();
