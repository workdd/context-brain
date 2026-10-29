'use strict';
// 로컬 전용 서버. 세션 로그를 읽어 SSE 로 브라우저에 자극 이벤트를 흘린다.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createState, parseLines, LOBES } = require('./lib/parse');
const { Tailer } = require('./lib/tail');
const { listSessions, isAllowed, observedCompactAt, sessionTitle } = require('./lib/sessions');
const { exportSession } = require('./lib/export');

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

let limits = null;
const getLimits = () => {
  if (!limits || Date.now() - limits.at > 5 * 60 * 1000) {
    limits = { at: Date.now(), ...observedCompactAt(listSessions(undefined, 40).map((x) => x.file)) };
  }
  return limits;
};
const resolveFile = (file) => {
  if (!file || file === 'latest') file = (listSessions(undefined, 1)[0] || {}).file;
  return file && isAllowed(file) && fs.existsSync(file) ? file : null;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname === '/api/sessions') return sendJson(res, 200, listSessions());
  if (url.pathname === '/api/limits') return sendJson(res, 200, getLimits());
  if (url.pathname === '/api/stream') {
    const file = resolveFile(url.searchParams.get('file'));
    if (!file) return sendJson(res, 404, { error: 'session not found' });
    return stream(req, res, file);
  }
  if (url.pathname === '/api/export') {
    const file = resolveFile(url.searchParams.get('file'));
    if (!file) return sendJson(res, 404, { error: 'session not found' });
    const redact = url.searchParams.get('redact') === '1';
    const html = exportSession(file, { redact, title: sessionTitle(file), compactAt: getLimits().compactAt });
    const name = `context-brain-${path.basename(file, '.jsonl').slice(0, 8)}${redact ? '-redacted' : ''}.html`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    return res.end(html);
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

// 포트가 차 있으면 다음 번호로 넘어간다
function listen(port = PORT, tries = 10) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && tries > 1) resolve(listen(port + 1, tries - 1));
      else reject(err);
    };
    const onListening = () => { server.off('error', onError); resolve(port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

if (require.main === module) {
  listen().then((port) => console.log(`context-brain: http://localhost:${port}`));
}

module.exports = { server, listen };
