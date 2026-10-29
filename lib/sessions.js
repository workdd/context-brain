'use strict';
// ~/.claude/projects 아래 세션 로그 목록. 서브에이전트 로그와 claude-mem 관찰 세션은 뺀다.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

function readTitle(file, size) {
  const len = Math.min(size, 256 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      if (!l.includes('"ai-title"')) continue;
      try { return JSON.parse(l).aiTitle; } catch (_) { /* 잘린 줄 */ }
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

function listSessions(root = ROOT, limit = 30) {
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.includes('claude-mem-observer')) continue;
    const dir = path.join(root, d.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      files.push({ file, project: d.name, mtime: st.mtimeMs, size: st.size });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map((s) => ({ ...s, title: readTitle(s.file, s.size) }));
}

// 경로 조작을 막는다: projects 폴더 안의 .jsonl 만 허용.
function isAllowed(file, root = ROOT) {
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(root) + path.sep) && resolved.endsWith('.jsonl');
}

module.exports = { ROOT, listSessions, isAllowed };
