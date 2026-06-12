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

function startWatch(noteId) {
  if (watched.has(noteId)) return;

  const state = { socket: null, timer: null, lastHit: Date.now() };
  watched.set(noteId, state);

  const socket = io(HEDGEDOC_URL, {
    query: { noteId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });
  state.socket = socket;

  socket.on('connect', () => log(`[${noteId}] connected`));
  socket.on('disconnect', reason => log(`[${noteId}] disconnected (${reason})`));

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

// Reverse proxy to marp (internal), touching lastHit for the note
function proxyToMarp(req, res) {
  // Extract noteId from path (first segment) to update lastHit
  const noteId = req.url.split('/').filter(Boolean)[0];
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
        return `<tr><td><a href="/${id}">${id}</a></td>` +
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/') return serveIndex(res);

  // /watch?note=abc  or  /watch/abc
  if (p === '/watch') {
    const noteId = url.searchParams.get('note')?.trim();
    if (!noteId) { res.writeHead(400); return res.end('Missing note parameter'); }
    startWatch(noteId);
    res.writeHead(302, { Location: `/${noteId}` });
    return res.end();
  }

  const watchMatch = p.match(/^\/watch\/(.+)$/);
  if (watchMatch) {
    startWatch(watchMatch[1]);
    res.writeHead(302, { Location: `/${watchMatch[1]}` });
    return res.end();
  }

  const unwatchMatch = p.match(/^\/unwatch\/(.+)$/);
  if (unwatchMatch) {
    stopWatch(unwatchMatch[1]);
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  proxyToMarp(req, res);
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
