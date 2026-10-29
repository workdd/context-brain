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
const lang = process.env.CB_LANG || (Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ko') ? 'ko' : 'en');
const { demoSession } = require('../lib/demo');
const { boot, turns } = demoSession(undefined, lang);

// 프로젝트 진단에 보이도록 같은 프로젝트의 지난 세션 두 개를 남긴다.
// 압축 기준은 같은 모델의 지난 자동 압축 크기로 잡으므로 두 세션 끝에 압축 기록을 둔다
[1, 2].forEach((daysAgo) => {
  const at = Date.now() - daysAgo * 86400000;
  const old = demoSession(at, lang);
  const lines = [...old.boot, ...old.turns.flat(2), { type: 'ai-title', aiTitle: lang === 'ko' ? `지난 작업 ${daysAgo}` : `Earlier work ${daysAgo}` }];
  lines.push({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 59000 + daysAgo * 1000 } });
  const f = path.join(dir, `earlier-${daysAgo}.jsonl`);
  fs.writeFileSync(f, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(f, new Date(at), new Date(at));
});

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
