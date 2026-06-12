const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { io } = require('socket.io-client');

const HEDGEDOC_URL = process.env.HEDGEDOC_URL || 'http://localhost:3000';
const DATA_DIR = process.env.DATA_DIR || '/data';
const SETTLE_MS = Number(process.env.SETTLE_MS || 2000);
const PORT = Number(process.env.PORT || 8080);
const MARP_PORT = Number(process.env.MARP_PORT || 8081);
const TTL_MS = Number(process.env.TTL_MS || 24 * 60 * 60 * 1000); // 24h default
const TTL_CHECK_MS = 5 * 60 * 1000; // check every 5 minutes

// noteId -> { socket, timer, lastHit }
const watched = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function outFile(noteId) {
  return path.join(DATA_DIR, `${noteId}.md`);
}

function fetchMarkdown(noteId) {
  return new Promise((resolve, reject) => {
    const base = HEDGEDOC_URL.endsWith('/') ? HEDGEDOC_URL : `${HEDGEDOC_URL}/`;
    const url = new URL(`${noteId}/download`, base).toString();

    function get(targetUrl) {
      const transport = targetUrl.startsWith('https') ? https : http;
      transport.get(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(new URL(res.headers.location, targetUrl).toString());
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    }

    get(url);
  });
}

// Obtain a signed session cookie from HedgeDoc. Its socket.io handshake
// rejects connections without a valid signed connect.sid cookie (even for
// anonymous/public notes), so we fetch one over HTTP first and reuse it in
// the socket handshake headers.
function getSessionCookie() {
  return new Promise((resolve, reject) => {
    const base = HEDGEDOC_URL.endsWith('/') ? HEDGEDOC_URL : `${HEDGEDOC_URL}/`;
    const transport = base.startsWith('https') ? https : http;
    // HedgeDoc marks the session cookie Secure when behind HTTPS and only
    // issues it when it believes the connection is secure. Internally we
    // reach it over plain HTTP, so advertise X-Forwarded-Proto: https
    // (HedgeDoc has trust proxy enabled) to get the Set-Cookie.
    const options = { headers: { 'X-Forwarded-Proto': 'https' } };
    transport.get(base, options, (res) => {
      res.resume(); // drain
      const setCookie = res.headers['set-cookie'];
      if (!setCookie || setCookie.length === 0) {
        reject(new Error('no set-cookie from HedgeDoc'));
        return;
      }
      // Keep only the "name=value" part of each cookie, joined for the header.
      const cookie = setCookie.map(c => c.split(';')[0]).join('; ');
      resolve(cookie);
    }).on('error', reject);
  });
}

async function startWatch(noteId) {
  if (watched.has(noteId)) return;

  const state = { socket: null, timer: null, lastHit: Date.now() };
  watched.set(noteId, state);

  // Immediately fetch the current content via HTTP so the file exists
  // right away, independent of the socket handshake.
  try {
    const markdown = await fetchMarkdown(noteId);
    fs.writeFileSync(outFile(noteId), markdown, 'utf8');
    log(`[${noteId}] initial fetch`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [${noteId}] initial fetch failed: ${e.message}`);
  }

  // Acquire a session cookie for the socket.io handshake (required by
  // HedgeDoc even for public notes).
  let cookie = '';
  try {
    cookie = await getSessionCookie();
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [${noteId}] cookie fetch failed: ${e.message}`);
  }

  const handshakeHeaders = { 'X-Forwarded-Proto': 'https' };
  if (cookie) handshakeHeaders.cookie = cookie;

  const socket = io(HEDGEDOC_URL, {
    query: { noteId },
    extraHeaders: handshakeHeaders,
    transportOptions: {
      polling: { extraHeaders: handshakeHeaders },
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });
  state.socket = socket;

  socket.on('connect', () => log(`[${noteId}] connected`));
  socket.on('disconnect', reason => log(`[${noteId}] disconnected (${reason})`));
  socket.on('connect_error', err => log(`[${noteId}] connect_error: ${err.message}`));
  socket.io.on('error', err => log(`[${noteId}] engine error: ${err.message}`));

  socket.on('doc', data => {
    const markdown = typeof data?.str === 'string' ? data.str : '';
    fs.writeFileSync(outFile(noteId), markdown, 'utf8');
    log(`[${noteId}] initial sync`);
  });

  socket.on('operation', () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      try {
        const markdown = await fetchMarkdown(noteId);
        fs.writeFileSync(outFile(noteId), markdown, 'utf8');
        log(`[${noteId}] synced`);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] [${noteId}] fetch failed: ${e.message}`);
      }
    }, SETTLE_MS);
  });
}

function stopWatch(noteId) {
  const state = watched.get(noteId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  if (state.socket) state.socket.close();
  watched.delete(noteId);
  try { fs.unlinkSync(outFile(noteId)); } catch {}
  log(`[${noteId}] stopped`);
}

// Serve a static asset (image, etc.) that lives on disk under DATA_DIR.
// Used so slide-referenced files like /assets/logo.svg resolve directly
// from the bind-mounted data dir, falling through to marp otherwise.
const MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

// Returns the resolved on-disk path if pathname maps to an existing,
// non-markdown file inside DATA_DIR (with traversal protection), else null.
function resolveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // Markdown is rendered by marp, never served raw here.
  if (rel.endsWith('.md')) return null;
  const root = path.resolve(DATA_DIR);
  const full = path.resolve(root, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (full !== root && !full.startsWith(root + path.sep)) return null; // traversal guard
  try {
    if (fs.statSync(full).isFile()) return full;
  } catch {}
  return null;
}

function serveStatic(fullPath, res) {
  const ext = path.extname(fullPath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(fullPath).on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }).pipe(res);
}

// Reverse proxy to marp (internal), touching lastHit for the note
function proxyToMarp(req, res) {
  // Extract noteId from path (first segment) to update lastHit
  const segment = req.url.split('/').filter(Boolean)[0] || '';
  const noteId = segment.endsWith('.md') ? segment.slice(0, -3) : segment;
  if (noteId && watched.has(noteId)) {
    watched.get(noteId).lastHit = Date.now();
  }

  const options = {
    hostname: 'localhost',
    port: MARP_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${MARP_PORT}` },
  };
  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Marp not ready yet — try again in a moment');
  });
  req.pipe(proxyReq);
}

function serveIndex(res) {
  let noteIds = [];
  try {
    noteIds = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3));
  } catch {}

  const rows = noteIds.length > 0
    ? noteIds.map(id => {
        const state = watched.get(id);
        const age = state ? Math.round((Date.now() - state.lastHit) / 60000) : '?';
        const ttlHours = Math.round(TTL_MS / 3600000);
        return `<tr><td><a href="/${id}.md">${id}</a></td>` +
          `<td>${age}m ago</td>` +
          `<td>expires after ${ttlHours}h idle</td>` +
          `<td><a href="/unwatch/${id}">stop</a></td></tr>`;
      }).join('\n')
    : '<tr><td colspan="4"><em>None yet</em></td></tr>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Marp Sync</title>
  <style>
    body { font-family: sans-serif; max-width: 640px; margin: 2em auto; color: #222; }
    h1 { color: #0070f3; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1.5em; }
    td, th { padding: 0.5em 0.75em; border: 1px solid #ddd; text-align: left; }
    th { background: #f5f5f5; }
    input { padding: 0.4em; width: 280px; font-size: 1em; }
    button { padding: 0.4em 1em; font-size: 1em; cursor: pointer; }
    .meta { color: #888; font-size: 0.85em; margin-top: 2em; }
  </style>
</head>
<body>
  <h1>Marp Sync</h1>
  <h2>Active notes</h2>
  <table>
    <tr><th>Note ID</th><th>Last hit</th><th>TTL</th><th>Action</th></tr>
    ${rows}
  </table>
  <h2>Watch a note</h2>
  <form action="/watch" method="GET">
    <input name="note" placeholder="Note ID or alias" required>
    <button type="submit">Watch &rarr;</button>
  </form>
  <p class="meta">HedgeDoc: <code>${HEDGEDOC_URL}</code> &nbsp;|&nbsp; settle: <code>${SETTLE_MS}ms</code></p>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/') return serveIndex(res);

  // /watch?note=abc  or  /watch/abc
  if (p === '/watch') {
    const noteId = url.searchParams.get('note')?.trim();
    if (!noteId) { res.writeHead(400); return res.end('Missing note parameter'); }
    await startWatch(noteId);
    res.writeHead(302, { Location: `/${noteId}.md` });
    return res.end();
  }

  const watchMatch = p.match(/^\/watch\/(.+)$/);
  if (watchMatch) {
    await startWatch(watchMatch[1]);
    res.writeHead(302, { Location: `/${watchMatch[1]}.md` });
    return res.end();
  }

  const unwatchMatch = p.match(/^\/unwatch\/(.+)$/);
  if (unwatchMatch) {
    stopWatch(unwatchMatch[1]);
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // Lazy auto-watch: if someone requests /{noteId}.md for a note we aren't
  // watching yet (e.g. after a restart), start watching and fetch it now so
  // marp can serve it on this request.
  const mdMatch = p.match(/^\/([^/]+)\.md$/);
  if (mdMatch && !watched.has(mdMatch[1]) && mdMatch[1] !== 'placeholder') {
    await startWatch(mdMatch[1]);
  }

  // Static asset fall-through: if the path maps to a real file on disk
  // under DATA_DIR (e.g. /assets/logo.svg), serve it directly.
  const staticPath = resolveStatic(p);
  if (staticPath) return serveStatic(staticPath, res);

  proxyToMarp(req, res);
});

// Proxy WebSocket upgrades to marp. Marp's server-mode live-reload client
// opens a WebSocket (/.__marp-cli-watch-notifier__/...) and reloads the page
// when marp detects a change to a watched file. Without proxying the upgrade,
// that channel never reaches marp and edits don't trigger a browser reload.
server.on('upgrade', (req, clientSocket, clientHead) => {
  const options = {
    hostname: 'localhost',
    port: MARP_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${MARP_PORT}` },
  };
  const proxyReq = http.request(options);

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    let resHead = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      resHead += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
    }
    resHead += '\r\n';
    clientSocket.write(resHead);
    if (proxyHead && proxyHead.length) clientSocket.write(proxyHead);

    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);

    const cleanup = () => { proxySocket.destroy(); clientSocket.destroy(); };
    proxySocket.on('error', cleanup);
    clientSocket.on('error', cleanup);
    proxySocket.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => proxySocket.destroy());
  });

  proxyReq.on('error', () => clientSocket.destroy());
  if (clientHead && clientHead.length) proxyReq.write(clientHead);
  proxyReq.end();
});

// TTL reaper: stop watching notes idle for longer than TTL_MS
setInterval(() => {
  const now = Date.now();
  for (const [noteId, state] of watched.entries()) {
    if (now - state.lastHit > TTL_MS) {
      log(`[${noteId}] TTL expired, unwatching`);
      stopWatch(noteId);
    }
  }
}, TTL_CHECK_MS).unref();

server.listen(PORT, () => log(`listening on :${PORT}, marp on :${MARP_PORT}`));

// Pre-warm a note if NOTE_ID is set at startup
const preWarm = process.env.NOTE_ID?.trim();
if (preWarm) {
  log(`pre-warming note: ${preWarm}`);
  startWatch(preWarm);
}

function shutdown() {
  for (const noteId of watched.keys()) stopWatch(noteId);
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
