'use strict';
// 로컬 전용 서버. 세션 로그를 읽어 SSE 로 브라우저에 자극 이벤트를 흘린다.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createState, parseLines, LOBES } = require('./lib/parse');
const { Tailer } = require('./lib/tail');
const { listSessions, isAllowed } = require('./lib/sessions');

const PORT = Number(process.env.PORT || 7788);
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function stream(req, res, file) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const state = createState();
  const tailer = new Tailer(file, (lines) => {
    const events = parseLines(lines, state);
    if (events.length) send('events', events);
  });
  // 처음 읽은 분량은 과거 기록으로 한 번에 보낸다.
  send('replay', { file, lobes: LOBES, events: parseLines(tailer.readNew(), state) });
  tailer.start();
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { tailer.stop(); clearInterval(ping); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname === '/api/sessions') return sendJson(res, 200, listSessions());
  if (url.pathname === '/api/stream') {
    let file = url.searchParams.get('file');
    if (!file || file === 'latest') file = (listSessions(undefined, 1)[0] || {}).file;
    if (!file || !isAllowed(file) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'session not found' });
    return stream(req, res, file);
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const target = path.resolve(PUBLIC, rel);
  if (!target.startsWith(PUBLIC + path.sep) || !fs.existsSync(target)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`context-brain: http://localhost:${PORT}`));
}

module.exports = { server };
