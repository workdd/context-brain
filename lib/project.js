'use strict';
// 한 세션과 같은 프로젝트 폴더의 최근 세션들을 파싱한다. 파일이 그대로면 다시 파싱하지 않는다.

const fs = require('fs');
const path = require('path');
const { parseFile } = require('./export');
const { sessionTitle } = require('./sessions');

const cache = new Map(); // file → { mtime, size, events }

function eventsOf(file, st) {
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.events;
  const events = parseFile(file);
  cache.set(file, { mtime: st.mtimeMs, size: st.size, events });
  return events;
}

function projectSessions(file, limit = 20) {
  const dir = path.dirname(file);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => { const p = path.join(dir, f); return { file: p, st: fs.statSync(p) }; })
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, limit)
    .map(({ file: f, st }) => ({ file: f, title: sessionTitle(f), mtime: st.mtimeMs, events: eventsOf(f, st) }));
}

module.exports = { projectSessions };
