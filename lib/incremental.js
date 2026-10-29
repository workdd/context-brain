'use strict';
// 상태줄처럼 자주 불리는 곳에서 쓰는 이어 읽기. 지난번 읽은 위치 · 파서 상태 · 이벤트를 임시 파일에 두고
// 그 뒤에 붙은 줄만 파싱한다. 진단에 필요한 필드만 남겨 캐시를 작게 유지한다.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createState, parseLines } = require('./parse');

const KEEP = ['t', 'kind', 'lobe', 'id', 'label', 'tokens', 'error', 'model'];
const slim = (e) => Object.fromEntries(KEEP.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));

function cachePath(file, dir) {
  return path.join(dir, crypto.createHash('sha1').update(path.resolve(file)).digest('hex') + '.json');
}

function parseIncremental(file, dir = path.join(os.tmpdir(), 'context-brain-cache')) {
  const st = fs.statSync(file);
  const where = cachePath(file, dir);
  let c = null;
  try { c = JSON.parse(fs.readFileSync(where, 'utf8')); } catch (_) { /* 처음 */ }
  if (!c || c.offset > st.size) c = { offset: 0, pending: [], known: [], events: [] }; // 파일이 줄었으면 처음부터
  if (c.offset < st.size) {
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(st.size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    const end = text.lastIndexOf('\n') + 1;   // 덜 쓴 마지막 줄은 다음에 읽는다
    const state = createState();
    state.pending = new Map(c.pending);
    state.known = new Map(c.known);
    c.events.push(...parseLines(text.slice(0, end).split('\n'), state).map(slim));
    c.offset += Buffer.byteLength(text.slice(0, end));
    c.pending = [...state.pending];
    c.known = [...state.known];
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(where, JSON.stringify(c));
    } catch (_) { /* 캐시를 못 쓰면 다음에 다시 읽는다 */ }
  }
  return c.events;
}

module.exports = { parseIncremental, cachePath };
