'use strict';
// 가짜 세션으로 뷰어를 띄운다. 실제 ~/.claude 를 읽지 않으므로 설치 확인이나 캡처에 쓴다.
//   node scripts/demo.js          → 데모 세션 생성 + 한 단계씩 실시간으로 추가
//   node scripts/demo.js --static → 전체 세션을 한 번에 쓰고 끝까지 추가하지 않음

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-brain-demo-'));
const dir = path.join(root, '-home-dev-shop-api');
fs.mkdirSync(dir);
const file = path.join(dir, 'demo-session.jsonl');
process.env.CLAUDE_PROJECTS_DIR = root;
// 압축 기준은 최근 세션에서 실제로 압축이 일어난 크기로 잡는다. 데모용으로 예전 세션 하나에 압축 기록을 남겨 둔다
const old = path.join(dir, 'earlier-session.jsonl');
fs.writeFileSync(old, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 60000 } }) + '\n');
const past = new Date(Date.now() - 86400000);
fs.utimesSync(old, past, past);

const lang = process.env.CB_LANG || (Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ko') ? 'ko' : 'en');
const { boot, turns } = require('../lib/demo').demoSession(undefined, lang);

const live = !process.argv.includes('--static');
const write = (entries, now = false) => fs.appendFileSync(file, entries
  .map((e) => JSON.stringify(now && e.timestamp ? { ...e, timestamp: new Date().toISOString() } : e)).join('\n') + '\n');

// 처음 두 턴은 지난 기록으로 쓰고, 그다음부터 한 단계씩 실시간으로 추가한다
write(boot);
const history = live ? 2 : turns.length;
turns.slice(0, history).forEach((t) => t.forEach((step) => write(step)));

const { listen } = require('../server');
listen().then((port) => {
  console.log(`context-brain demo: http://localhost:${port}`);
  console.log(`demo session: ${file}`);
  if (process.env.CB_OPEN) require('../lib/open')(`http://localhost:${port}`);
});

if (live) {
  let t = history % turns.length;
  let i = 0;
  setTimeout(function next() {
    write(turns[t][i], true);
    i++;
    if (i === turns[t].length) { i = 0; t = (t + 1) % turns.length; }
    setTimeout(next, i === 0 ? 6000 : 1800);
  }, 2500);
}

process.on('SIGINT', () => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); });
